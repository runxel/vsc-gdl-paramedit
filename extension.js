'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const P = require('./src/paramlist');

// Übersetzung der Oberflächentexte. Quelltexte sind Englisch, die Übersetzung
// steht in l10n/bundle.l10n.<sprache>.json (siehe "l10n" in der package.json).
const t = (...args) => vscode.l10n.t(...args);

const VIEW_TYPE = 'gdl.parameterEditor';

// Die Original-Extension (Upstream), von der dieser Fork abstammt. Beide
// registrieren denselben viewType für dieselben Dateien — parallel installiert
// gewinnt stillschweigend eine der beiden, die andere schlägt beim Registrieren
// fehl. Deshalb: erkennen und deutlich warnen.
const ORIGINAL_EXT_ID = 'b-prisma.gdl-parameter-editor';

function warnIfOriginalInstalled() {
	if (!vscode.extensions.getExtension(ORIGINAL_EXT_ID)) return false;
	// Beschriftungen einmal übersetzen — die Antwort kommt als genau dieser Text zurück.
	const uninstall = t('Uninstall original (b-prisma)');
	const showExts = t('Show extensions');
	const reload = t('Reload window');
	vscode.window.showWarningMessage(
		t('Conflict: the original "GDL Parameter Editor" (b-prisma) and this fork (runxel) are ' +
			'installed at the same time. Both claim the same files (paramlist.xml / Parameters.xml) — ' +
			'only one of them works. Please uninstall one of the two extensions.'),
		uninstall,
		showExts
	).then((choice) => {
		if (choice === uninstall) {
			vscode.commands
				.executeCommand('workbench.extensions.uninstallExtension', ORIGINAL_EXT_ID)
				.then(
					() => vscode.window
						.showInformationMessage(t('Original uninstalled. Reload the window so the fork takes over the editor.'), reload)
						.then((c) => { if (c === reload) vscode.commands.executeCommand('workbench.action.reloadWindow'); }),
					(e) => vscode.window.showErrorMessage(t('Uninstall failed: {0}', String(e && e.message || e)))
				);
		} else if (choice === showExts) {
			vscode.commands.executeCommand('workbench.extensions.search', 'gdl-parameter-editor');
		}
	});
	return true;
}

function activate(context) {
	// Meldungen des Datenkerns in der Sprache der Oberfläche — der Kern selbst
	// kennt VS Code nicht (die Tests laufen in nacktem Node).
	P.setL10n(vscode.l10n);

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
				vscode.window.showErrorMessage(t('Duplicating failed: {0}', String(e && e.message || e)));
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
				vscode.window.showErrorMessage(t('Pasting failed: {0}', String(e && e.message || e)));
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
				t('GDL Parameter Editor (fork): the editor could not be registered — the original ' +
					'extension (b-prisma) is probably installed as well. Please uninstall one of the two.')
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
				names.length === 1 ? t('1 parameter copied') : t('{0} parameters copied', names.length), 3000);
		} catch (e) {
			vscode.window.showErrorMessage(t('Copying failed: {0}', String(e && e.message || e)));
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

		// Felder, nach denen die Liste neu gerendert werden muss (Identität/Optik
		// ändert sich). Value/Description nicht — das Eingabefeld zeigt es bereits.
		const RERENDER = ['move', 'reorder', 'add', 'delete', 'duplicate', 'paste', 'type', 'name', 'flag',
			'arrayAddRow', 'arrayDelRow', 'arrayAddCol', 'arrayDelCol', 'arrayCreate', 'arrayRemove'];

		/** Einmalig neu rendern, sobald das laufende Speichern durch ist. */
		const renderAfterSave = () => {
			const sub = vscode.workspace.onDidSaveTextDocument((d) => {
				if (d.uri.toString() !== document.uri.toString()) return;
				sub.dispose();
				render();
			});
			setTimeout(() => sub.dispose(), 5000); // Sicherheitsnetz, falls nie gespeichert wird
		};

		// Cmd+S nimmt dem Eingabefeld im Webview NICHT den Fokus: dessen
		// 'change' — und damit die Änderung am Dokument — kommt erst beim
		// Wegklicken, also erst NACH dem Speichern. Die Datei wäre dadurch sofort
		// wieder „geändert" (Punkt im Tab) und müsste ein zweites Mal gespeichert
		// werden. Deshalb vor dem Speichern beim Webview nachfragen und das
		// Getippte als TextEdit in den Speichervorgang einhängen.
		const flushPending = async () => {
			const edits = await requestFlush(webview);
			if (!edits.length) return [];
			const oldText = document.getText();
			const doc = P.parse(oldText);
			let changed = false;
			for (const m of edits) {
				try {
					if (await this.mutate(doc, m)) changed = true;
				} catch (e) {
					// Ungültige Eingabe (Name, Zahl): nicht übernehmen, aber auch
					// das Speichern nicht blockieren.
					webview.postMessage({ type: 'notice', message: String(e.message || e) });
				}
			}
			if (!changed) return [];
			const newText = P.serialize(doc);
			if (newText === oldText) return [];
			lastWritten = newText; // eigener Edit → kein Neu-Rendern (Fokus bleibt)
			// Umbenennen & Co. ändern die Identität der Zeilen — das Webview muss
			// die neue Wahrheit sehen, sonst zeigen seine Nachrichten ins Leere.
			if (edits.some((m) => RERENDER.includes(m.field))) renderAfterSave();
			return [vscode.TextEdit.replace(
				new vscode.Range(document.positionAt(0), document.positionAt(oldText.length)),
				newText
			)];
		};

		const willSaveSub = vscode.workspace.onWillSaveTextDocument((e) => {
			if (e.document.uri.toString() !== document.uri.toString()) return;
			// Nur bei „echtem" Speichern und beim Verlassen des Editors. Bei
			// files.autoSave: afterDelay würde sonst mitten im Tippen übernommen
			// (halbe Zahlen, Hinweis-Spam) — dort genügt der 'change' beim Verlassen.
			if (e.reason === vscode.TextDocumentSaveReason.AfterDelay) return;
			e.waitUntil(flushPending());
		});

		panel.onDidDispose(() => {
			changeSub.dispose();
			willSaveSub.dispose();
			this.selections.delete(document.uri.toString());
			if (this.activeDocument === document) this.activeDocument = null;
		});

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
	 * Wendet eine Änderung auf den geparsten Baum an (schreibt noch nichts).
	 * Wirft bei ungültigen Eingaben; liefert false, wenn nichts zu tun war.
	 */
	async mutate(doc, msg) {
		const findTarget = () => P.getParameters(doc).find((p) => p.name === msg.name);

		switch (msg.field) {
			case 'value': { const target = findTarget(); if (!target) return false; P.setValueByType(target.node, target.type, msg.value); break; }
			case 'description': { const target = findTarget(); if (!target) return false; P.setDescription(target.node, msg.value); break; }
			case 'name': {
				const target = findTarget(); if (!target) return false;
				const nm = String(msg.value || '').trim();
				if (!P.isValidName(nm)) throw new Error(t('Invalid name "{0}". Allowed: letters, digits, underscore (starting with a letter or _), at most {1} characters.', nm, P.MAX_NAME_LENGTH));
				if (P.nameExists(doc, nm, target.node)) throw new Error(t('The name "{0}" already exists. Names must be unique.', nm));
				P.setName(target.node, nm); break;
			}
			case 'type': { const target = findTarget(); if (!target) return false; P.setType(target.node, msg.value); break; }
			// 'fix' ist absichtlich KEIN Editier-Feld: <Fix/> wird vom Subtype des
			// Objekts bestimmt und darf nie über den Editor gesetzt/entfernt werden.
			case 'flag': { const target = findTarget(); if (!target) return false; P.setFlag(target.node, msg.flag, !!msg.value); break; }
			case 'move': P.moveParam(doc, msg.name, msg.delta); break;
			case 'reorder': P.reorderParams(doc, msg.names || []); break;
			case 'delete': {
				// Ein Name oder eine Mehrfachauswahl — in einem Undo-Schritt.
				// Fixe Parameter (vom Subtype vorgegeben) sind nie löschbar;
				// hier nochmals erzwungen, unabhängig vom Webview.
				const all = P.getParameters(doc);
				const wanted = msg.names && msg.names.length ? msg.names : [msg.name];
				const deletable = wanted.filter((n) => {
					const target = all.find((p) => p.name === n);
					return target && !target.fix;
				});
				if (!deletable.length) {
					throw new Error(t('Fix parameters (blue, dictated by the subtype) cannot be deleted.'));
				}
				P.deleteParams(doc, deletable);
				break;
			}
			case 'duplicate': {
				const target = findTarget(); if (!target) return false;
				// Namen sind eindeutig (case-insensitiv): "_new" anhängen,
				// bei erneutem Duplizieren "_new2", "_new3", … Der Basisname wird
				// bei Bedarf gekürzt, damit das 32-Zeichen-Limit eingehalten bleibt.
				const mk = (suffix) => target.name.slice(0, P.MAX_NAME_LENGTH - suffix.length) + suffix;
				let newName = mk('_new');
				for (let n = 2; P.nameExists(doc, newName, null); n++) newName = mk('_new' + n);
				P.duplicateParam(doc, target.name, newName);
				break;
			}
			case 'paste': {
				// Zwischenablage → Parameter: Namen werden bei Kollision eindeutig
				// gemacht, <Fix/> wird entfernt (gilt nur für den Subtype der Quelldatei).
				const clip = await vscode.env.clipboard.readText();
				const frags = P.parseParamFragments(clip);
				if (!frags.length) throw new Error(t('The clipboard does not contain any GDL parameters (XML from "Copy").'));
				P.insertParams(doc, frags, msg.afterName || null);
				break;
			}
			case 'add': {
				const nm = String(msg.newName || '').trim();
				if (!P.isValidName(nm)) throw new Error(t('Invalid name "{0}" (max. {1} characters).', nm, P.MAX_NAME_LENGTH));
				if (P.nameExists(doc, nm, null)) throw new Error(t('The name "{0}" already exists.', nm));
				P.addParam(doc, { type: msg.paramType, name: nm, afterName: msg.afterName || null });
				break;
			}
			case 'arraycell': { const target = findTarget(); if (!target) return false; P.setArrayCell(target.node, msg.row, msg.col, msg.value); break; }
			case 'arrayAddRow': { const target = findTarget(); if (!target) return false; P.addArrayRow(target.node); break; }
			case 'arrayDelRow': { const target = findTarget(); if (!target) return false; P.removeArrayRow(target.node, msg.row); break; }
			case 'arrayAddCol': { const target = findTarget(); if (!target) return false; P.addArrayCol(target.node); break; }
			case 'arrayDelCol': { const target = findTarget(); if (!target) return false; P.removeArrayCol(target.node, msg.col); break; }
			case 'arrayCreate': { const target = findTarget(); if (!target) return false; P.createArray(target.node, msg.rows || 1, msg.cols || 0); break; }
			case 'arrayRemove': { const target = findTarget(); if (!target) return false; P.removeArray(target.node); break; }
			default: return false;
		}
		return true;
	}

	/**
	 * Wendet eine Änderung an und schreibt das (round-trip-sichere) Ergebnis als
	 * ein WorkspaceEdit zurück. Gibt den neuen Text zurück (oder null).
	 */
	async applyEdit(document, msg) {
		const doc = P.parse(document.getText());
		if (!(await this.mutate(doc, msg))) return null;

		const newText = P.serialize(doc);
		if (newText === document.getText()) return null;

		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(
			document.positionAt(0),
			document.positionAt(document.getText().length)
		);
		edit.replace(document.uri, fullRange, newText);
		// Schlägt fehl, wenn das Dokument gerade gespeichert/verändert wird —
		// dann darf das Webview nicht weiter den neuen Stand zeigen (der Fehler
		// führt zu Hinweis + Neu-Rendern aus der Datei).
		if (!(await vscode.workspace.applyEdit(edit))) {
			throw new Error(t('The change could not be applied — please try again.'));
		}
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
		// Wörterbuch fürs Webview: dort gibt es kein vscode.l10n. '<' maskieren,
		// damit ein Text niemals das <script> vorzeitig beenden kann.
		const strings = JSON.stringify(webviewBundle(this.context.extensionPath)).replace(/</g, '\\u003c');
		return `<!DOCTYPE html>
<html lang="${esc(vscode.env.language || 'en')}">
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
			<input id="filter" type="text" placeholder="${esc(t('Filter (name or description)…'))}">
			<button id="filterClear" title="${esc(t('Clear filter (Esc)'))}" hidden>✕</button>
		</span>
		<button id="addBtn" title="${esc(t('Add a new parameter at the end'))}">${esc(t('+ Parameter'))}</button>
		<button id="addGroupBtn" title="${esc(t('Add a new group heading (Title)'))}">${esc(t('+ Group'))}</button>
		<button id="addSeparatorBtn" title="${esc(t('Add a new separator bar (Separator)'))}">${esc(t('+ Separator'))}</button>
		<span id="count" class="muted"></span>
	</div>
	<div id="error" class="error" hidden></div>
	<div id="notice" class="notice" hidden></div>
	<div id="colhead"></div>
	<div id="list"></div>
	<script nonce="${nonce}">window.__l10n = ${strings};</script>
	<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
	}

}

/**
 * Fragt das Webview nach Eingaben, die noch in einem Feld stehen (getippt, aber
 * noch nicht übernommen — 'change' kommt erst beim Verlassen des Feldes).
 * Antwortet es nicht rechtzeitig, wird ohne sie gespeichert: der Speichervorgang
 * darf nie an einem hängenden Webview hängen bleiben.
 */
function requestFlush(webview, timeoutMs = 400) {
	return new Promise((resolve) => {
		let done = false;
		let timer = null;
		const finish = (edits) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			sub.dispose();
			resolve(edits);
		};
		const sub = webview.onDidReceiveMessage((msg) => {
			if (msg && msg.type === 'flushed') finish(Array.isArray(msg.edits) ? msg.edits : []);
		});
		timer = setTimeout(() => finish([]), timeoutMs);
		try {
			webview.postMessage({ type: 'flush' }).then(
				(ok) => { if (!ok) finish([]); },
				() => finish([])
			);
		} catch (e) {
			finish([]); // Webview schon geschlossen — dann eben ohne Nachfrage speichern
		}
	});
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

/** Maskiert Text fürs Einsetzen in HTML-Attribute/-Inhalte. */
function esc(s) {
	return String(s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Übersetzungen fürs Webview: dort steht vscode.l10n nicht zur Verfügung.
// Statt die Texte doppelt zu pflegen, wandert die komplette Bundle-Datei der
// aktiven Sprache ins Webview — die Schlüssel sind dort wie hier die
// englischen Quelltexte. Ohne passendes Bundle (Englisch, oder eine Sprache
// ohne Übersetzung) bleibt die Karte leer und das Webview zeigt seine
// Quelltexte an.
let webviewBundleCache = null;
function webviewBundle(extensionPath) {
	if (webviewBundleCache) return webviewBundleCache;
	const lang = vscode.env.language || 'en';
	// 'de-DE' → erst 'de-DE', dann 'de' versuchen.
	for (const code of [lang, lang.split('-')[0]]) {
		try {
			const raw = fs.readFileSync(
				path.join(extensionPath, 'l10n', 'bundle.l10n.' + code + '.json'), 'utf8');
			const map = JSON.parse(raw);
			// Das l10n-Format erlaubt statt eines Strings auch { message, comment }.
			for (const k of Object.keys(map)) {
				if (map[k] && typeof map[k] === 'object') map[k] = map[k].message;
			}
			return (webviewBundleCache = map);
		} catch (e) { /* nächste Sprachvariante probieren */ }
	}
	return (webviewBundleCache = {});
}

function makeNonce() {
	let s = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
	return s;
}

function deactivate() {}

module.exports = { activate, deactivate };
