'use strict';

const vscode = require('vscode');
const P = require('./src/paramlist');

const VIEW_TYPE = 'gdl.parameterEditor';

// Die Original-Extension (Upstream), von der dieser Fork abstammt. Beide
// registrieren denselben viewType für dieselben Dateien — parallel installiert
// gewinnt stillschweigend eine der beiden, die andere schlägt beim Registrieren
// fehl. Deshalb: erkennen und deutlich warnen.
const ORIGINAL_EXT_ID = 'b-prisma.gdl-parameter-editor';

function warnIfOriginalInstalled() {
	if (!vscode.extensions.getExtension(ORIGINAL_EXT_ID)) return false;
	vscode.window.showWarningMessage(
		'Konflikt: Der originale „GDL Parameter Editor" (b-prisma) und dieser Fork (runxel) ' +
		'sind gleichzeitig installiert. Beide beanspruchen dieselben Dateien (paramlist.xml / ' +
		'Parameters.xml) — nur einer von beiden funktioniert. Bitte eine der beiden Extensions deinstallieren.',
		'Original (b-prisma) deinstallieren',
		'Extensions anzeigen'
	).then((choice) => {
		if (choice === 'Original (b-prisma) deinstallieren') {
			vscode.commands
				.executeCommand('workbench.extensions.uninstallExtension', ORIGINAL_EXT_ID)
				.then(
					() => vscode.window
						.showInformationMessage('Original deinstalliert. Fenster neu laden, damit der Fork den Editor übernimmt.', 'Neu laden')
						.then((c) => { if (c === 'Neu laden') vscode.commands.executeCommand('workbench.action.reloadWindow'); }),
					(e) => vscode.window.showErrorMessage('Deinstallation fehlgeschlagen: ' + String(e && e.message || e))
				);
		} else if (choice === 'Extensions anzeigen') {
			vscode.commands.executeCommand('workbench.extensions.search', 'gdl-parameter-editor');
		}
	});
	return true;
}

function activate(context) {
	// Läuft dank onStartupFinished immer — auch wenn das Original den viewType
	// „gewonnen" hat und dieser Fork sonst nie aktiviert würde.
	let conflictWarned = warnIfOriginalInstalled();

	// Auch erkennen, wenn das Original NACHTRÄGLICH installiert wird.
	context.subscriptions.push(
		vscode.extensions.onDidChange(() => {
			if (vscode.extensions.getExtension(ORIGINAL_EXT_ID)) {
				if (!conflictWarned) conflictWarned = warnIfOriginalInstalled();
			} else {
				conflictWarned = false;
			}
		})
	);

	const provider = new ParamEditorProvider(context);

	// Kontextmenü-Befehle (Rechtsklick auf eine Zeile im Webview).
	// ctx ist das data-vscode-context-Objekt des angeklickten Elements.
	context.subscriptions.push(
		vscode.commands.registerCommand('gdl.parameterEditor.duplicate', async (ctx) => {
			const document = provider.activeDocument;
			const name = ctx && ctx.paramName;
			if (!document || !name) return;
			try {
				await provider.applyEdit(document, { field: 'duplicate', name });
			} catch (e) {
				vscode.window.showErrorMessage('Duplizieren fehlgeschlagen: ' + String(e && e.message || e));
			}
		}),
		// „Kopieren": legt die Auswahl (bzw. die angeklickte Zeile) als XML-
		// Fragment in die System-Zwischenablage — zum Übertragen von Parametern
		// zwischen zwei paramlist.xml-Dateien (auch über Fenster hinweg).
		vscode.commands.registerCommand('gdl.parameterEditor.copy', async (ctx) => {
			const document = provider.activeDocument;
			const name = ctx && ctx.paramName;
			if (!document || !name) return;
			const sel = provider.selections.get(document.uri.toString()) || [];
			await provider.copyToClipboard(document, sel.includes(name) ? sel : [name]);
		}),
		// „Einfügen": liest Parameter-XML aus der Zwischenablage und fügt es
		// nach der angeklickten Zeile ein (ohne paramName: am Listenende).
		vscode.commands.registerCommand('gdl.parameterEditor.paste', async (ctx) => {
			const document = provider.activeDocument;
			if (!document) return;
			try {
				await provider.applyEdit(document, { field: 'paste', afterName: (ctx && ctx.paramName) || null });
			} catch (e) {
				vscode.window.showErrorMessage('Einfügen fehlgeschlagen: ' + String(e && e.message || e));
			}
		})
	);

	try {
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider(
				VIEW_TYPE,
				provider,
				{
					webviewOptions: { retainContextWhenHidden: true },
					supportsMultipleEditorsPerDocument: false,
				}
			)
		);
	} catch (e) {
		// viewType schon vergeben → das Original war schneller. Ohne Warnung
		// sähe der Nutzer nur kommentarlos den falschen Editor.
		if (!conflictWarned) {
			vscode.window.showErrorMessage(
				'GDL Parameter Editor (Fork): Editor konnte nicht registriert werden — ' +
				'vermutlich ist die Original-Extension (b-prisma) ebenfalls installiert. ' +
				'Bitte eine der beiden deinstallieren.'
			);
		}
	}
}

class ParamEditorProvider {
	constructor(context) {
		this.context = context;
		// Dokument des zuletzt aktiven Editor-Panels — Ziel für Kontextmenü-
		// Befehle (Rechtsklick geht immer im fokussierten Webview auf).
		this.activeDocument = null;
		// Aktuelle Mehrfachauswahl je Dokument (vom Webview gemeldet) —
		// damit „Kopieren" im Kontextmenü die ganze Auswahl erwischt.
		this.selections = new Map();
	}

	/** Kopiert die genannten Parameter als XML-Fragment in die Zwischenablage. */
	async copyToClipboard(document, names) {
		if (!names || !names.length) return;
		try {
			const xml = P.extractParamsXml(P.parse(document.getText()), names);
			if (!xml) return;
			await vscode.env.clipboard.writeText(xml);
			vscode.window.setStatusBarMessage(
				names.length === 1 ? '1 Parameter kopiert' : names.length + ' Parameter kopiert', 3000);
		} catch (e) {
			vscode.window.showErrorMessage('Kopieren fehlgeschlagen: ' + String(e && e.message || e));
		}
	}

	/**
	 * @param {vscode.TextDocument} document
	 * @param {vscode.WebviewPanel} panel
	 */
	async resolveCustomTextEditor(document, panel, _token) {
		this.activeDocument = document;
		panel.onDidChangeViewState(() => { if (panel.active) this.activeDocument = document; });

		const webview = panel.webview;
		webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		webview.html = this.getHtml(webview);

		// Text, den wir zuletzt selbst geschrieben haben — zum Erkennen eigener Edits.
		let lastWritten = null;

		const render = () => {
			let params = [];
			let error = null;
			try {
				params = P.getParameters(P.parse(document.getText())).map(toView);
			} catch (e) {
				error = e.message;
			}
			webview.postMessage({ type: 'render', params, error });
		};

		const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() !== document.uri.toString()) return;
			// Eigene Edits nicht erneut rendern (Fokus/Scroll bleiben erhalten).
			if (document.getText() === lastWritten) return;
			render();
		});
		panel.onDidDispose(() => {
			changeSub.dispose();
			this.selections.delete(document.uri.toString());
			if (this.activeDocument === document) this.activeDocument = null;
		});

		// Felder, nach denen die Liste neu gerendert werden muss (Identität/Optik
		// ändert sich). Value/Description nicht — das Eingabefeld zeigt es bereits.
		const RERENDER = ['move', 'reorder', 'add', 'delete', 'duplicate', 'paste', 'type', 'name', 'flag',
			'arrayAddRow', 'arrayDelRow', 'arrayAddCol', 'arrayDelCol', 'arrayCreate', 'arrayRemove'];

		webview.onDidReceiveMessage(async (msg) => {
			if (msg.type === 'ready') {
				// Gespeicherte Spaltenbreiten mitschicken, bevor gerendert wird.
				webview.postMessage({ type: 'cols', cols: this.context.globalState.get('colWidths') || {} });
				render();
				return;
			}
			// Spaltenbreiten global merken (gelten für alle Dateien und Fenster).
			if (msg.type === 'colWidths') { this.context.globalState.update('colWidths', msg.cols || {}); return; }
			// Auswahl-Zustand des Webviews (für Kontextmenü „Kopieren").
			if (msg.type === 'selection') { this.selections.set(document.uri.toString(), msg.names || []); return; }
			// Cmd/Ctrl+C im Webview: Auswahl in die Zwischenablage.
			if (msg.type === 'copy') { await this.copyToClipboard(document, msg.names || []); return; }
			if (msg.type !== 'edit') return;
			try {
				const newText = await this.applyEdit(document, msg);
				if (newText !== null) lastWritten = newText;
				if (RERENDER.includes(msg.field)) render();
			} catch (e) {
				// Validierungs-/Editierfehler: kurze Meldung + UI auf Wahrheit zurücksetzen.
				webview.postMessage({ type: 'notice', message: String(e.message || e) });
				render();
			}
		});
	}

	/**
	 * Wendet eine Änderung an und schreibt das (round-trip-sichere) Ergebnis als
	 * ein WorkspaceEdit zurück. Gibt den neuen Text zurück (oder null).
	 */
	async applyEdit(document, msg) {
		const doc = P.parse(document.getText());
		const findTarget = () => P.getParameters(doc).find((p) => p.name === msg.name);

		switch (msg.field) {
			case 'value': { const t = findTarget(); if (!t) return null; P.setValueByType(t.node, t.type, msg.value); break; }
			case 'description': { const t = findTarget(); if (!t) return null; P.setDescription(t.node, msg.value); break; }
			case 'name': {
				const t = findTarget(); if (!t) return null;
				const nm = String(msg.value || '').trim();
				if (!P.isValidName(nm)) throw new Error('Ungültiger Name „' + nm + '". Erlaubt: Buchstaben, Ziffern, Unterstrich (Beginn mit Buchstabe oder _), maximal ' + P.MAX_NAME_LENGTH + ' Zeichen.');
				if (P.nameExists(doc, nm, t.node)) throw new Error('Der Name „' + nm + '" existiert bereits. Namen müssen eindeutig sein.');
				P.setName(t.node, nm); break;
			}
			case 'type': { const t = findTarget(); if (!t) return null; P.setType(t.node, msg.value); break; }
			// 'fix' ist absichtlich KEIN Editier-Feld: <Fix/> wird vom Subtype des
			// Objekts bestimmt und darf nie über den Editor gesetzt/entfernt werden.
			case 'flag': { const t = findTarget(); if (!t) return null; P.setFlag(t.node, msg.flag, !!msg.value); break; }
			case 'move': P.moveParam(doc, msg.name, msg.delta); break;
			case 'reorder': P.reorderParams(doc, msg.names || []); break;
			case 'delete': {
				// Ein Name oder eine Mehrfachauswahl — in einem Undo-Schritt.
				// Fixe Parameter (vom Subtype vorgegeben) sind nie löschbar;
				// hier nochmals erzwungen, unabhängig vom Webview.
				const all = P.getParameters(doc);
				const wanted = msg.names && msg.names.length ? msg.names : [msg.name];
				const deletable = wanted.filter((n) => {
					const t = all.find((p) => p.name === n);
					return t && !t.fix;
				});
				if (!deletable.length) {
					throw new Error('Fixe Parameter (blau, vom Subtype vorgegeben) können nicht gelöscht werden.');
				}
				P.deleteParams(doc, deletable);
				break;
			}
			case 'duplicate': {
				const t = findTarget(); if (!t) return null;
				// Namen sind eindeutig (case-insensitiv): "_new" anhängen,
				// bei erneutem Duplizieren "_new2", "_new3", … Der Basisname wird
				// bei Bedarf gekürzt, damit das 32-Zeichen-Limit eingehalten bleibt.
				const mk = (suffix) => t.name.slice(0, P.MAX_NAME_LENGTH - suffix.length) + suffix;
				let newName = mk('_new');
				for (let n = 2; P.nameExists(doc, newName, null); n++) newName = mk('_new' + n);
				P.duplicateParam(doc, t.name, newName);
				break;
			}
			case 'paste': {
				// Zwischenablage → Parameter: Namen werden bei Kollision eindeutig
				// gemacht, <Fix/> wird entfernt (gilt nur für den Subtype der Quelldatei).
				const clip = await vscode.env.clipboard.readText();
				const frags = P.parseParamFragments(clip);
				if (!frags.length) throw new Error('Die Zwischenablage enthält keine GDL-Parameter (XML aus „Kopieren").');
				P.insertParams(doc, frags, msg.afterName || null);
				break;
			}
			case 'add': {
				const nm = String(msg.newName || '').trim();
				if (!P.isValidName(nm)) throw new Error('Ungültiger Name „' + nm + '" (max. ' + P.MAX_NAME_LENGTH + ' Zeichen).');
				if (P.nameExists(doc, nm, null)) throw new Error('Der Name „' + nm + '" existiert bereits.');
				P.addParam(doc, { type: msg.paramType, name: nm, afterName: msg.afterName || null });
				break;
			}
			case 'arraycell': { const t = findTarget(); if (!t) return null; P.setArrayCell(t.node, msg.row, msg.col, msg.value); break; }
			case 'arrayAddRow': { const t = findTarget(); if (!t) return null; P.addArrayRow(t.node); break; }
			case 'arrayDelRow': { const t = findTarget(); if (!t) return null; P.removeArrayRow(t.node, msg.row); break; }
			case 'arrayAddCol': { const t = findTarget(); if (!t) return null; P.addArrayCol(t.node); break; }
			case 'arrayDelCol': { const t = findTarget(); if (!t) return null; P.removeArrayCol(t.node, msg.col); break; }
			case 'arrayCreate': { const t = findTarget(); if (!t) return null; P.createArray(t.node, msg.rows || 1, msg.cols || 0); break; }
			case 'arrayRemove': { const t = findTarget(); if (!t) return null; P.removeArray(t.node); break; }
			default: return null;
		}

		const newText = P.serialize(doc);
		if (newText === document.getText()) return null;

		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(
			document.positionAt(0),
			document.positionAt(document.getText().length)
		);
		edit.replace(document.uri, fullRange, newText);
		await vscode.workspace.applyEdit(edit);
		return newText;
	}

	getHtml(webview) {
		const nonce = makeNonce();
		const css = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css')
		);
		const js = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.js')
		);
		const csp =
			`default-src 'none'; ` +
			`img-src ${webview.cspSource}; ` +
			`style-src ${webview.cspSource} 'unsafe-inline'; ` +
			`script-src 'nonce-${nonce}';`;
		return `<!DOCTYPE html>
<html lang="de">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${css}" rel="stylesheet">
	<title>GDL Parameter Editor</title>
</head>
<body>
	<div id="toolbar">
		<span id="filterWrap">
			<input id="filter" type="text" placeholder="Filtern (Name oder Beschreibung)…">
			<button id="filterClear" title="Filter löschen (Esc)" hidden>✕</button>
		</span>
		<button id="addBtn" title="Neuen Parameter am Ende hinzufügen">+ Parameter</button>
		<button id="addGroupBtn" title="Neue Gruppen-Überschrift (Title) hinzufügen">+ Gruppe</button>
		<button id="addSeparatorBtn" title="Neuen Trennbalken (Separator) hinzufügen">+ Trennlinie</button>
		<span id="count" class="muted"></span>
	</div>
	<div id="error" class="error" hidden></div>
	<div id="notice" class="notice" hidden></div>
	<div id="colhead"></div>
	<div id="list"></div>
	<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
	}

}

/** Reduziert einen Parameter auf ein serialisierbares View-DTO (ohne Baum-Knoten). */
function toView(p) {
	return {
		type: p.type,
		name: p.name,
		isTitle: p.isTitle,
		isSeparator: p.isSeparator,
		isValue: p.isValue,
		valueKind: p.valueKind,
		fix: p.fix,
		flags: p.flags,
		hidden: p.flags.includes('ParFlg_Hidden'),
		child: p.flags.includes('ParFlg_Child'),
		bold: p.flags.includes('ParFlg_BoldName'),
		unique: p.flags.includes('ParFlg_Unique'),
		description: p.description,
		valueText: p.valueText,
		isArray: !!p.array,
		array: p.array
			? {
					first: p.array.first,
					second: p.array.second,
					cells: p.array.values.map((v) => ({
						row: v.row,
						col: v.col,
						value: p.valueKind === 'string' ? P.unescapeGdlStr(P.stripQuotes(v.value)) : v.value,
					})),
				}
			: null,
	};
}

function makeNonce() {
	let s = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
	return s;
}

function deactivate() {}

module.exports = { activate, deactivate };
