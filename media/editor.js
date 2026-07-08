'use strict';

// Webview-Frontend des GDL Parameter Editors.
// Kommuniziert per postMessage mit dem Extension-Host (kein REST, keine DB).

(function () {
	const vscode = acquireVsCodeApi();

	const listEl = document.getElementById('list');
	const filterEl = document.getElementById('filter');
	const filterClearEl = document.getElementById('filterClear');
	const countEl = document.getElementById('count');
	const errorEl = document.getElementById('error');
	const noticeEl = document.getElementById('notice');
	const addBtn = document.getElementById('addBtn');
	let noticeTimer = null;

	// Typen für das Dropdown (Wert-Typen; Title/Separator sind Strukturzeilen).
	const TYPES = [
		'Length', 'Integer', 'RealNum', 'Angle', 'String', 'Boolean',
		'PenColor', 'LineType', 'FillPattern', 'Material', 'BuildingMaterial',
		'Profile', 'Dictionary',
	];

	// „Fix" ist bewusst NICHT dabei: es wird vom Subtype des Objekts bestimmt
	// (externe Quelle) und darf nie vom Nutzer gesetzt werden — ein falsches
	// <Fix/> kann das GDL-Objekt zum Absturz bringen oder unkompilierbar machen.
	// Fixe Parameter werden nur angezeigt: blaue Zeile, wie im Archicad-Editor.
	// Reihenfolge wie im Archicad-Parametereditor: Hide, Child, Bold, Unique.
	// Hide und Child bekommen SVG-Icons nach dem Archicad-Vorbild (X bzw.
	// Einrück-Pfeil); Bold/Unique bleiben Buchstaben. Das X erbt currentColor:
	// inaktiv neutral grau, aktiv rot (per CSS, ohne Button-Hintergrund —
	// Theme-Farben könnten sonst mit dem Icon kollidieren).
	const SVG_HIDDEN =
		'<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">' +
		'<path d="M3 3 13 13 M13 3 3 13" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
	const SVG_CHILD =
		'<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" fill="none" ' +
		'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
		'<path d="M3.5 3.5v9"/><path d="M3.5 8h8.5"/><path d="M9 4.5 12.5 8 9 11.5"/></svg>';
	const FLAG_DEFS = [
		{ key: 'hidden', svg: SVG_HIDDEN, title: 'Versteckt (ParFlg_Hidden)', flag: 'ParFlg_Hidden' },
		{ key: 'child', svg: SVG_CHILD, title: 'Untergeordnet/eingerückt (ParFlg_Child)', flag: 'ParFlg_Child' },
		{ key: 'bold', label: 'B', title: 'Fett (ParFlg_BoldName)', flag: 'ParFlg_BoldName' },
		{ key: 'unique', label: 'U', title: 'Eindeutig (ParFlg_Unique)', flag: 'ParFlg_Unique' },
	];

	let params = [];
	let dragNames = null; // aktuell gezogene Parameter (Drag & Drop, ggf. Mehrfachauswahl)
	const expanded = new Set(); // Namen der aufgeklappten Array-Parameter
	const selected = new Set(); // Namen der ausgewählten Zeilen (Mehrfachauswahl)
	let anchorName = null; // Anker der Bereichsauswahl (Shift-Klick)
	const rowByName = new Map(); // Name → gerenderte Zeile (Auswahl-/Drag-Styling)
	let lastShown = 0; // zuletzt gerenderte Zeilenanzahl (für die Zähler-Anzeige)

	// ── Client-seitige Validierung (Spiegel der Datenkern-Regeln, nur für
	//    sofortiges Feedback; der Extension-Host bleibt die maßgebliche Prüfung) ──
	const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // keine Ziffer am Anfang, keine
	// Leer-/Sonderzeichen außer _, keine Umlaute/ß
	const MAX_NAME_LEN = 32; // Archicad-Limit für Parameternamen
	function isValidNameC(n) { return NAME_RE.test(n || '') && n.length <= MAX_NAME_LEN; }

	const INDEX_TYPES = new Set(['PenColor', 'LineType', 'FillPattern', 'Material', 'BuildingMaterial', 'Profile', 'Dictionary']);
	// Liefert {ok, value} — value ist die normalisierte Zahl (Komma→Punkt).
	function normNumberC(type, text) {
		const s = String(text == null ? '' : text).trim().replace(/,/g, '.');
		const intOnly = type === 'Integer' || INDEX_TYPES.has(type);
		const re = intOnly ? /^-?\d+$/ : /^-?(?:\d+\.?\d*|\.\d+)$/;
		return { ok: re.test(s), value: s, intOnly };
	}

	const NAME_RULE = 'Erlaubt: Buchstaben, Ziffern und _ — Beginn mit Buchstabe oder _, ' +
		'keine Leerzeichen, keine Umlaute/ß, keine sonstigen Sonderzeichen, maximal ' +
		MAX_NAME_LEN + ' Zeichen.';

	// Verdrahtet ein Namens-Eingabefeld: Live-Markierung ungültiger Zeichen +
	// Prüfung beim Verlassen (ungültig → Hinweis, Feld auf Wahrheit zurück).
	function wireNameInput(input, p) {
		input.maxLength = MAX_NAME_LEN;
		input.addEventListener('input', () =>
			input.classList.toggle('invalid', input.value.trim() !== '' && !isValidNameC(input.value.trim())));
		commitOnChange(input, () => {
			const v = input.value.trim();
			if (!isValidNameC(v)) {
				showNotice('Ungültiger Name „' + v + '". ' + NAME_RULE);
				input.value = p.name || '';
				input.classList.remove('invalid');
				return;
			}
			input.classList.remove('invalid');
			send({ field: 'name', name: p.name, value: v });
			flash(input);
		});
	}

	window.addEventListener('message', (ev) => {
		const msg = ev.data;
		if (msg.type === 'render') {
			if (msg.error) {
				errorEl.hidden = false;
				errorEl.textContent = 'Parse-Fehler: ' + msg.error;
				return;
			}
			errorEl.hidden = true;
			params = msg.params || [];
			render();
		} else if (msg.type === 'notice') {
			showNotice(msg.message);
		} else if (msg.type === 'cols') {
			// Gespeicherte Spaltenbreiten vom Extension-Host (globalState).
			applyCols(msg.cols || {});
		}
	});

	function showNotice(text) {
		noticeEl.hidden = false;
		noticeEl.textContent = '⚠ ' + text;
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => { noticeEl.hidden = true; }, 5000);
	}

	filterEl.addEventListener('input', render);
	// Esc im Filterfeld leert den Filter (statt z. B. den Fokus zu verlieren).
	filterEl.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && filterEl.value) {
			e.preventDefault();
			e.stopPropagation();
			clearFilter();
		}
	});
	filterClearEl.addEventListener('click', () => { clearFilter(); filterEl.focus(); });

	function clearFilter() {
		filterEl.value = '';
		render();
	}
	addBtn.addEventListener('click', addParam);
	document.getElementById('addGroupBtn').addEventListener('click', addGroup);
	document.getElementById('addSeparatorBtn').addEventListener('click', addSeparator);

	// Kontextmenü auch abseits der Zeilen (leere Fläche): dort gibt es nur
	// „Einfügen" — ohne paramName landet der Inhalt am Listenende.
	document.body.dataset.vscodeContext = JSON.stringify({
		webviewSection: 'list',
		preventDefaultContextMenuItems: true,
	});

	// ── Verstellbare Spaltenbreiten: Griffe in der Kopfzeile setzen die
	//    CSS-Variablen auf <body>; die Untergrenzen (--min-*) stehen im
	//    Stylesheet. Gespeichert wird über den Extension-Host (globalState),
	//    damit die Breiten für alle Dateien und Fenster gelten. ──
	const COLS = [
		{ label: 'Name', widthVar: '--col-name', minVar: '--min-name' },
		{ label: 'Typ', widthVar: '--col-type', minVar: '--min-type' },
		{ label: 'Beschreibung', widthVar: '--col-desc', minVar: '--min-desc' },
	];

	// Unsichtbarer Mess-Span: ermittelt die Breite des längsten Namens in der
	// .pname-Schrift, damit die Name-Spalte nie schmaler wird als ihr Inhalt.
	const measureEl = el('span');
	measureEl.id = 'measure';
	document.body.appendChild(measureEl);

	// Die Name-Spalte ist mindestens so breit wie der längste Name — Namen
	// sind ohnehin auf 32 Zeichen begrenzt, das bleibt also im Rahmen.
	// Alle Namen in einem Span (eine Zeile pro Name, white-space: pre) messen:
	// die Breite ist dann die der längsten Zeile — eine einzige Messung.
	function updateNameMin() {
		const meas = (names) => {
			if (!names.length) return 0;
			measureEl.textContent = names.join('\n');
			return Math.ceil(measureEl.getBoundingClientRect().width);
		};
		const plain = meas(params.filter((p) => !p.child).map((p) => p.name || ''));
		const child = meas(params.filter((p) => p.child).map((p) => p.name || ''));
		// +14px Padding/Rahmen des Eingabefelds; Child-Zeilen sind 14px eingerückt.
		const w = Math.max(plain, child ? child + 14 : 0) + 14;
		document.body.style.setProperty('--min-name', Math.max(90, w) + 'px');
	}

	function initColumns() {
		// Mess-Span bekommt exakt die Schrift der echten .pname-Eingabefelder —
		// Inputs erben die Schriftgröße nicht automatisch vom Body, daher von
		// einem unsichtbaren Probe-Input abgreifen statt raten.
		const probe = document.createElement('input');
		probe.className = 'pname';
		probe.style.position = 'absolute';
		probe.style.visibility = 'hidden';
		document.body.appendChild(probe);
		const pf = getComputedStyle(probe);
		measureEl.style.fontFamily = pf.fontFamily;
		measureEl.style.fontSize = pf.fontSize;
		measureEl.style.letterSpacing = pf.letterSpacing;
		probe.remove();

		const head = document.getElementById('colhead');
		head.appendChild(el('span')); // Platzhalter über den Steuer-Buttons
		// Flags-Spalte „Darstellung" (wie im Archicad-Editor): Ghost-Chips
		// halten die Spalte exakt so breit wie in den Zeilen, das Label liegt
		// absolut darüber, damit es die Breite nicht beeinflusst.
		const flagsHead = el('span', 'flags-head');
		flagsHead.appendChild(renderFlags({}, []));
		flagsHead.appendChild(el('span', 'flags-head-label', 'Darstellung'));
		head.appendChild(flagsHead);
		for (const c of COLS) head.appendChild(headCell(c));
		head.appendChild(el('span', 'col-label', 'Wert')); // Rest-Spalte, ohne Griff

		// Gemessene Breite der Flags-Spalte (+6px margin) → fließt in die
		// Mindestbreite der Zeilen ein (ab der horizontal gescrollt wird).
		const flags = head.querySelector('.flags');
		document.body.style.setProperty('--flags-w', (flags.offsetWidth + 6) + 'px');

		// Kopfzeile klebt direkt unter der Toolbar; deren Höhe hängt von
		// Schriftgröße/Zoom ab, daher messen statt raten.
		const toolbar = document.getElementById('toolbar');
		const setTop = () => document.body.style.setProperty('--toolbar-h', toolbar.offsetHeight + 'px');
		new ResizeObserver(setTop).observe(toolbar);
		setTop();
	}

	function headCell(c) {
		const cell = el('span', 'col-label', c.label);
		const grip = el('span', 'col-grip');
		grip.title = 'Ziehen: Spaltenbreite ändern — Doppelklick: zurücksetzen';
		grip.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			grip.setPointerCapture(e.pointerId);
			const bodyStyle = getComputedStyle(document.body);
			const min = parseFloat(bodyStyle.getPropertyValue(c.minVar)) || 60;
			const startW = parseFloat(bodyStyle.getPropertyValue(c.widthVar)) || min;
			const startX = e.clientX;
			const onMove = (ev) => document.body.style.setProperty(
				c.widthVar, Math.round(Math.max(min, startW + ev.clientX - startX)) + 'px');
			const done = () => {
				grip.removeEventListener('pointermove', onMove);
				grip.removeEventListener('pointerup', done);
				grip.removeEventListener('pointercancel', done);
				saveCols();
			};
			grip.addEventListener('pointermove', onMove);
			grip.addEventListener('pointerup', done);
			grip.addEventListener('pointercancel', done);
		});
		grip.addEventListener('dblclick', () => {
			document.body.style.removeProperty(c.widthVar); // zurück auf Standardbreite
			saveCols();
		});
		cell.appendChild(grip);
		return cell;
	}

	function applyCols(cols) {
		for (const c of COLS) {
			if (cols[c.widthVar]) document.body.style.setProperty(c.widthVar, cols[c.widthVar]);
			else document.body.style.removeProperty(c.widthVar);
		}
	}

	function saveCols() {
		const cols = {};
		for (const c of COLS) {
			const v = document.body.style.getPropertyValue(c.widthVar);
			if (v) cols[c.widthVar] = v;
		}
		vscode.postMessage({ type: 'colWidths', cols });
	}

	function render() {
		updateNameMin();
		const q = filterEl.value.trim().toLowerCase();
		filterClearEl.hidden = !filterEl.value;
		listEl.textContent = '';
		rowByName.clear();
		pruneSelection();
		let shown = 0;
		for (const p of params) {
			if (q && !matches(p, q)) continue;
			shown++;
			if (p.isSeparator) { listEl.appendChild(renderSeparator(p)); continue; }
			if (p.isTitle) { listEl.appendChild(renderTitle(p)); continue; }
			listEl.appendChild(renderParam(p));
			if (p.isArray && expanded.has(p.name)) listEl.appendChild(renderArrayPanel(p));
		}
		lastShown = shown;
		updateCount();
	}

	function updateCount() {
		countEl.textContent = lastShown + ' / ' + params.length + ' Parameter' +
			(selected.size ? ' · ' + selected.size + ' ausgewählt' : '');
	}

	function matches(p, q) {
		return (p.name && p.name.toLowerCase().includes(q)) ||
			(p.description && p.description.toLowerCase().includes(q));
	}

	function renderTitle(p) {
		const row = el('div', 'row title' + (p.fix ? ' fix' : '') + (p.hidden ? ' hidden' : ''));
		row.appendChild(renderControls(p));

		// Nur das Hidden-Flag — vertikal bündig mit den Flags der Parameterzeilen
		row.appendChild(renderFlags(p, ['hidden']));

		const name = document.createElement('input');
		name.type = 'text';
		name.className = 'pname';
		name.value = p.name || '';
		name.title = 'Gruppen-Name (intern, eindeutig)';
		wireNameInput(name, p);
		row.appendChild(name);

		const cap = document.createElement('input');
		cap.type = 'text';
		cap.className = 'title-text';
		cap.value = p.description != null ? p.description : '';
		cap.placeholder = 'Gruppen-Überschrift';
		commitOnChange(cap, () => { send({ field: 'description', name: p.name, value: cap.value }); flash(cap); });
		row.appendChild(cap);

		wireRowSelection(row, p);
		setRowContext(row, p);
		makeRowDroppable(row, p);
		return row;
	}

	// Trennbalken (Separator): nur interner Name + Trennlinie, KEIN Überschriften-Text.
	function renderSeparator(p) {
		const row = el('div', 'row separator' + (p.fix ? ' fix' : ''));
		row.appendChild(renderControls(p));

		const name = document.createElement('input');
		name.type = 'text';
		name.className = 'pname';
		name.value = p.name || '';
		name.title = 'Trennbalken-Name (intern, eindeutig)';
		wireNameInput(name, p);
		row.appendChild(name);

		const line = el('span', 'separator-line');
		line.title = 'Trennbalken (ohne Überschrift)';
		row.appendChild(line);

		wireRowSelection(row, p);
		setRowContext(row, p);
		makeRowDroppable(row, p);
		return row;
	}

	function renderParam(p) {
		const row = el('div', 'row' + (p.child ? ' child' : '') + (p.hidden ? ' hidden' : '') + (p.fix ? ' fix' : '') + (p.bold ? ' bold' : ''));
		if (p.fix) row.title = 'Fix — vom Subtype vorgegeben';

		row.appendChild(renderControls(p));

		// Flags — wie im Archicad-Editor links, direkt neben dem Papierkorb
		row.appendChild(renderFlags(p));

		// Name (editierbar)
		const name = document.createElement('input');
		name.type = 'text';
		name.className = 'pname';
		name.value = p.name || '';
		wireNameInput(name, p);
		row.appendChild(name);

		// Typ-Dropdown — zwischen Name und Beschreibung
		const sel = document.createElement('select');
		sel.className = 'type-select';
		for (const t of TYPES) {
			const o = document.createElement('option');
			o.value = t; o.textContent = t;
			if (t === p.type) o.selected = true;
			sel.appendChild(o);
		}
		if (!TYPES.includes(p.type)) { // unbekannter Typ trotzdem zeigen
			const o = document.createElement('option');
			o.value = p.type; o.textContent = p.type; o.selected = true;
			sel.insertBefore(o, sel.firstChild);
		}
		sel.addEventListener('change', () => send({ field: 'type', name: p.name, value: sel.value }));
		row.appendChild(sel);

		// Beschreibung (editierbar)
		const desc = document.createElement('input');
		desc.type = 'text';
		desc.className = 'desc';
		desc.value = p.description != null ? p.description : '';
		desc.placeholder = 'Beschreibung';
		commitOnChange(desc, () => { send({ field: 'description', name: p.name, value: desc.value }); flash(desc); });
		row.appendChild(desc);

		// Wert
		row.appendChild(renderValue(p));

		wireRowSelection(row, p);
		setRowContext(row, p);
		makeRowDroppable(row, p);
		return row;
	}

	function renderControls(p) {
		const c = el('span', 'controls');
		const handle = el('span', 'drag-handle', '⠿');
		handle.title = 'Ziehen zum Verschieben';
		handle.draggable = true;
		handle.addEventListener('dragstart', (e) => {
			// Gehört die Zeile zur Mehrfachauswahl, wandert die GANZE Auswahl mit.
			dragNames = selected.has(p.name) && selected.size > 1 ? orderedSelection() : [p.name];
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', dragNames.join('\n'));
			for (const n of dragNames) {
				const r = rowByName.get(n);
				if (r) r.classList.add('dragging');
			}
		});
		handle.addEventListener('dragend', () => {
			dragNames = null;
			setDropMarker(null);
			for (const r of rowByName.values()) r.classList.remove('dragging');
		});
		c.appendChild(handle);
		c.appendChild(iconBtn('＋', 'Neuen Parameter unter diesem einfügen', () =>
			send({ field: 'add', paramType: 'Length', newName: makeUniqueName(), afterName: p.name })));
		// Fixe Parameter (blau, vom Subtype vorgegeben) sind nicht löschbar —
		// sie bekommen erst gar keinen Papierkorb.
		if (!p.fix) {
			c.appendChild(iconBtn('🗑',
				'Löschen — bei Mehrfachauswahl alle ausgewählten (rückgängig mit Cmd+Z)',
				() => requestDelete(selected.has(p.name) && selected.size > 1 ? orderedSelection() : [p.name])));
		}
		return c;
	}

	// Löscht die genannten Parameter in EINEM Schritt (ein Undo) — fixe
	// Parameter (blau) werden ausgefiltert und bleiben erhalten.
	function requestDelete(names) {
		const fixNames = new Set(params.filter((x) => x.fix).map((x) => x.name));
		const deletable = names.filter((n) => !fixNames.has(n));
		if (deletable.length !== names.length) {
			showNotice('Fixe Parameter (blau, vom Subtype vorgegeben) können nicht gelöscht werden' +
				(deletable.length ? ' — sie bleiben erhalten.' : '.'));
		}
		if (!deletable.length) return;
		send({ field: 'delete', names: deletable });
	}

	function makeUniqueName(base) {
		base = base || 'neuerParameter';
		const existing = new Set(params.map((p) => (p.name || '').toLowerCase()));
		let n = 1, name;
		do { name = base + n++; } while (existing.has(name.toLowerCase()));
		return name;
	}

	// ── Mehrfachauswahl: Klick = Einzelauswahl, Cmd/Ctrl-Klick = umschalten,
	//    Shift-Klick = Bereich, Esc = aufheben. Die Auswahl wird dem Extension-
	//    Host gemeldet, damit „Kopieren" im Kontextmenü die ganze Auswahl
	//    erwischt; gezogen wird sie als Block (siehe Drag & Drop unten). ──

	/** Auswahl in Dokument-Reihenfolge (params ist die Wahrheit, nicht die Klick-Reihenfolge). */
	function orderedSelection() {
		return params.filter((p) => selected.has(p.name)).map((p) => p.name);
	}

	function postSelection() {
		vscode.postMessage({ type: 'selection', names: orderedSelection() });
		updateCount();
	}

	function updateSelectionClasses() {
		for (const [n, r] of rowByName) r.classList.toggle('selected', selected.has(n));
	}

	function clearSelection() {
		if (!selected.size) return;
		selected.clear();
		anchorName = null;
		updateSelectionClasses();
		postSelection();
	}

	/** Entfernt verwaiste Namen (nach Löschen/Umbenennen) aus der Auswahl. */
	function pruneSelection() {
		const names = new Set(params.map((p) => p.name));
		let changed = false;
		for (const n of [...selected]) if (!names.has(n)) { selected.delete(n); changed = true; }
		if (anchorName && !names.has(anchorName)) anchorName = null;
		if (changed) postSelection();
	}

	function wireRowSelection(row, p) {
		rowByName.set(p.name, row);
		if (selected.has(p.name)) row.classList.add('selected');
		row.addEventListener('click', (e) => {
			if (e.target.closest('input, select, button')) return; // Editierfelder nicht kapern
			if (e.shiftKey && anchorName) {
				const names = params.map((x) => x.name);
				let a = names.indexOf(anchorName);
				const b = names.indexOf(p.name);
				if (a < 0) a = b;
				if (!(e.metaKey || e.ctrlKey)) selected.clear();
				for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(names[i]);
			} else if (e.metaKey || e.ctrlKey) {
				if (selected.has(p.name)) selected.delete(p.name); else selected.add(p.name);
				anchorName = p.name;
			} else {
				// Einfacher Klick: nur diese Zeile — erneuter Klick hebt die Einzelauswahl auf.
				const wasOnly = selected.size === 1 && selected.has(p.name);
				selected.clear();
				if (!wasOnly) selected.add(p.name);
				anchorName = wasOnly ? null : p.name;
			}
			updateSelectionClasses();
			postSelection();
		});
	}

	// Tastatur: Cmd/Ctrl+C kopiert die Auswahl als XML in die Zwischenablage,
	// Cmd/Ctrl+V fügt Parameter aus der Zwischenablage ein (hinter der Auswahl),
	// Cmd/Ctrl+A wählt alle sichtbaren Zeilen, Esc hebt die Auswahl auf.
	// In Eingabefeldern bleibt das native Verhalten unangetastet.
	document.addEventListener('keydown', (e) => {
		const inField = e.target && e.target.closest && e.target.closest('input, select, textarea');
		if (e.key === 'Escape' && !inField) { clearSelection(); return; }
		// Entf (bzw. Cmd/Ctrl+Backspace) löscht die Auswahl — fixe Parameter
		// filtert requestDelete heraus.
		if (!inField && selected.size &&
			(e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)))) {
			e.preventDefault();
			requestDelete(orderedSelection());
			return;
		}
		if (!(e.metaKey || e.ctrlKey) || inField) return;
		const k = (e.key || '').toLowerCase();
		if (k === 'c') {
			const names = orderedSelection();
			if (!names.length) return;
			e.preventDefault();
			vscode.postMessage({ type: 'copy', names });
		} else if (k === 'v') {
			e.preventDefault();
			const sel = orderedSelection();
			const afterName = sel.length ? sel[sel.length - 1]
				: (params.length ? params[params.length - 1].name : null);
			send({ field: 'paste', afterName });
		} else if (k === 'a') {
			e.preventDefault();
			for (const n of rowByName.keys()) selected.add(n); // nur sichtbare (gefilterte) Zeilen
			updateSelectionClasses();
			postSelection();
		}
	});

	// VS-Code-natives Kontextmenü (Rechtsklick): „Duplizieren", „Kopieren",
	// „Einfügen" — die Befehle sind in package.json unter webview/context
	// registriert und bekommen dieses Objekt (inkl. paramName) übergeben.
	function setRowContext(row, p) {
		row.dataset.vscodeContext = JSON.stringify({
			webviewSection: 'param',
			paramName: p.name,
			preventDefaultContextMenuItems: true,
		});
	}

	// ── Drag & Drop: Zeile(n) auf eine andere ziehen → einsortieren.
	//    Obere Zeilenhälfte = davor, untere Hälfte = dahinter — nur so lässt
	//    sich auch HINTER die letzte Zeile schieben. Eine Mehrfachauswahl
	//    wandert als zusammenhängender Block. ──
	let dropMarkerRow = null; // Zeile, die gerade die Einfüge-Linie zeigt
	function setDropMarker(row, after) {
		if (dropMarkerRow && dropMarkerRow !== row) dropMarkerRow.classList.remove('drop-target', 'drop-target-after');
		dropMarkerRow = row;
		if (!row) return;
		row.classList.toggle('drop-target', !after);
		row.classList.toggle('drop-target-after', !!after);
	}
	function makeRowDroppable(row, p) {
		row.addEventListener('dragover', (e) => {
			if (!dragNames || dragNames.includes(p.name)) return;
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = 'move';
			const r = row.getBoundingClientRect();
			setDropMarker(row, e.clientY > r.top + r.height / 2);
		});
		row.addEventListener('dragleave', () => { if (dropMarkerRow === row) setDropMarker(null); });
		row.addEventListener('drop', (e) => {
			e.preventDefault();
			e.stopPropagation();
			const after = row.classList.contains('drop-target-after');
			setDropMarker(null);
			if (dragNames && !dragNames.includes(p.name)) reorderTo(dragNames, p.name, after);
		});
	}
	// Leerer Bereich UNTER der letzten Zeile: dort fallen lassen = ans Ende.
	// (Zeilen-Handler stoppen die Propagation, hier kommt nur der Rest an.)
	function lastRowEl() {
		for (let n = listEl.lastElementChild; n; n = n.previousElementSibling) {
			if (n.classList.contains('row')) return n;
		}
		return null;
	}
	document.addEventListener('dragover', (e) => {
		if (!dragNames) return;
		const last = lastRowEl();
		if (!last || e.clientY <= last.getBoundingClientRect().bottom) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		setDropMarker(last, true);
	});
	document.addEventListener('drop', (e) => {
		if (!dragNames) return;
		const last = lastRowEl();
		if (!last || e.clientY <= last.getBoundingClientRect().bottom) return;
		e.preventDefault();
		setDropMarker(null);
		reorderTo(dragNames, null, true);
	});
	function reorderTo(fromNames, targetName, after) {
		// Bewegte Zeilen in Dokument-Reihenfolge als Block am Ziel einfügen;
		// after = hinter dem Ziel, targetName null = ganz ans Ende.
		const moving = params.map((p) => p.name).filter((n) => fromNames.includes(n));
		if (!moving.length) return;
		const rest = params.map((p) => p.name).filter((n) => !fromNames.includes(n));
		const ti = targetName == null ? -1 : rest.indexOf(targetName);
		rest.splice(ti < 0 ? rest.length : ti + (after ? 1 : 0), 0, ...moving);
		send({ field: 'reorder', names: rest });
	}

	function renderValue(p) {
		const wrap = el('span', 'value');
		if (p.isArray) {
			const dims = p.array.second > 0 ? p.array.first + '×' + p.array.second : String(p.array.first);
			const btn = el('button', 'array-toggle', (expanded.has(p.name) ? '▾ ' : '▸ ') + 'Array [' + dims + ']');
			btn.addEventListener('click', () => {
				if (expanded.has(p.name)) expanded.delete(p.name); else expanded.add(p.name);
				render();
			});
			wrap.appendChild(btn);
			return wrap;
		}
		if (p.valueKind === 'boolean') {
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.checked = p.valueText === '1';
			cb.addEventListener('change', () => { send({ field: 'value', name: p.name, value: cb.checked ? '1' : '0' }); flash(cb); });
			wrap.appendChild(cb);
			wrap.appendChild(makeArrayBtn(p));
			return wrap;
		}
		if (p.valueKind === 'dict') {
			// Dictionary: <Value> ist ein Container, nicht skalar editierbar.
			// Hier nur anzeigen (Einträge werden im Editor derzeit nicht bearbeitet).
			const badge = el('span', 'dict-badge', 'Dictionary');
			badge.title = 'Dictionary-Inhalt kann nicht in der Parameterliste festgelegt werden.';
			wrap.appendChild(badge);
			return wrap;
		}
		const inp = document.createElement('input');
		inp.type = 'text';
		inp.className = 'val ' + p.valueKind;
		inp.value = p.valueText != null ? p.valueText : '';
		const numeric = p.valueKind === 'number' || p.valueKind === 'index';
		if (numeric) inp.inputMode = 'decimal';
		inp.addEventListener('input', () => {
			if (numeric) inp.classList.toggle('invalid', inp.value.trim() !== '' && !normNumberC(p.type, inp.value).ok);
		});
		commitOnChange(inp, () => {
			if (numeric) {
				const r = normNumberC(p.type, inp.value);
				if (!r.ok) {
					inp.classList.add('invalid');
					showNotice('„' + inp.value + '" ist keine ' + (r.intOnly ? 'ganze Zahl' : 'gültige Zahl') + '. ' + p.type + '-Wert unverändert.');
					inp.value = p.valueText != null ? p.valueText : '';
					return;
				}
				inp.classList.remove('invalid');
				inp.value = r.value;        // normalisierte Anzeige (Komma→Punkt)
				p.valueText = r.value;
				send({ field: 'value', name: p.name, value: r.value });
				flash(inp);
				return;
			}
			send({ field: 'value', name: p.name, value: inp.value });
			flash(inp);
		});
		wrap.appendChild(inp);
		wrap.appendChild(makeArrayBtn(p));
		return wrap;
	}

	// „In Array umwandeln"-Button (⊞) — für alle wertetragenden Typen gleich.
	function makeArrayBtn(p) {
		const b = iconBtn('⊞', 'In Array umwandeln', () => {
			expanded.add(p.name);
			send({ field: 'arrayCreate', name: p.name, rows: 1, cols: 0 });
		});
		b.classList.add('array-make');
		return b;
	}

	// only: optionale Liste von Flag-Keys — Titel bekommen z. B. nur 'hidden'.
	// Ausgefilterte Flags werden als unsichtbare Platzhalter gerendert, damit
	// die Flags-Spalte überall gleich breit ist und die Namen fluchten.
	function renderFlags(p, only) {
		const box = el('span', 'flags');
		for (const f of FLAG_DEFS) {
			const ghost = only && !only.includes(f.key);
			const active = !ghost && !!p[f.key];
			const chip = el('button', 'chip chip-' + f.key + (active ? ' active' : '') + (ghost ? ' ghost' : ''));
			if (f.svg) chip.innerHTML = f.svg; else chip.textContent = f.label;
			if (ghost) {
				chip.tabIndex = -1;
			} else {
				chip.title = f.title;
				chip.addEventListener('click', () => send({ field: 'flag', name: p.name, flag: f.flag, value: !active }));
			}
			box.appendChild(chip);
		}
		return box;
	}

	function renderArrayPanel(p) {
		const panel = el('div', 'array-panel');
		const a = p.array;
		const is2D = a.second > 0;
		const cols = is2D ? a.second : 1;
		// Zell-Map (1D unter Spalte 1 normiert) + vorhandene Zeilen (sparse-fähig).
		const map = new Map(a.cells.map((c) => [c.row + ':' + (c.col > 0 ? c.col : 1), c.value]));
		const rowsPresent = [...new Set(a.cells.map((c) => c.row))].sort((x, y) => x - y);

		// Buttons zuerst (feste Position!), Größen-Label dahinter — sonst
		// verschiebt eine Textänderung (z.B. „(1D)" → „2 × 3") die Buttons
		// unter dem Mauszeiger.
		const bar = el('div', 'array-bar');
		bar.appendChild(txtBtn('+ Zeile', 'Zeile am Ende anhängen', () => send({ field: 'arrayAddRow', name: p.name })));
		bar.appendChild(txtBtn('+ Spalte', is2D ? 'Spalte anhängen' : 'In 2D umwandeln (Spalte hinzufügen)', () => send({ field: 'arrayAddCol', name: p.name })));
		bar.appendChild(txtBtn('Kein Array', 'In skalaren Wert zurückwandeln', () => send({ field: 'arrayRemove', name: p.name })));
		bar.appendChild(el('span', 'muted', is2D ? (a.first + ' × ' + a.second) : (a.first + ' Zeilen (1D)')));
		panel.appendChild(bar);

		const table = el('table', 'array-table');
		if (is2D) {
			const tr = document.createElement('tr');
			tr.appendChild(el('td', 'array-rowhead', ''));
			for (let c = 1; c <= cols; c++) {
				const td = el('td', 'array-colhead');
				td.appendChild(el('span', null, 'Sp ' + c + ' '));
				td.appendChild(iconBtn('✕', 'Spalte ' + c + ' löschen', () => send({ field: 'arrayDelCol', name: p.name, col: c })));
				tr.appendChild(td);
			}
			table.appendChild(tr);
		}
		for (const r of rowsPresent) {
			const tr = document.createElement('tr');
			const head = el('td', 'array-rowhead');
			head.appendChild(el('span', null, String(r) + ' '));
			head.appendChild(iconBtn('✕', 'Zeile ' + r + ' löschen', () => send({ field: 'arrayDelRow', name: p.name, row: r })));
			tr.appendChild(head);
			for (let c = 1; c <= cols; c++) {
				const sendCol = is2D ? c : 0; // setArrayCell erwartet 0 bei 1D
				const td = document.createElement('td');
				const v = map.get(r + ':' + c);
				if (p.valueKind === 'boolean') {
					// Boolean-Zellen als Checkbox (wie der skalare Wert) —
					// so landet nie ungültiger Freitext im <AVal>.
					const cb = document.createElement('input');
					cb.type = 'checkbox';
					cb.checked = v === '1';
					cb.addEventListener('change', () => { send({ field: 'arraycell', name: p.name, row: r, col: sendCol, value: cb.checked ? '1' : '0' }); flash(cb); });
					td.appendChild(cb);
					tr.appendChild(td);
					continue;
				}
				const inp = document.createElement('input');
				inp.type = 'text';
				inp.className = 'val ' + p.valueKind;
				inp.value = v != null ? v : '';
				const numericCell = p.valueKind === 'number' || p.valueKind === 'index';
				if (numericCell) inp.inputMode = 'decimal';
				commitOnChange(inp, () => {
					if (numericCell) {
						const rN = normNumberC(p.type, inp.value);
						if (!rN.ok) {
							inp.classList.add('invalid');
							showNotice('„' + inp.value + '" ist keine ' + (rN.intOnly ? 'ganze Zahl' : 'gültige Zahl') + '. Zelle unverändert.');
							inp.value = v != null ? v : '';
							return;
						}
						inp.classList.remove('invalid');
						inp.value = rN.value;
						send({ field: 'arraycell', name: p.name, row: r, col: sendCol, value: rN.value });
						flash(inp);
						return;
					}
					send({ field: 'arraycell', name: p.name, row: r, col: sendCol, value: inp.value });
					flash(inp);
				});
				td.appendChild(inp);
				tr.appendChild(td);
			}
			table.appendChild(tr);
		}
		panel.appendChild(table);
		return panel;
	}

	function addParam() {
		const afterName = params.length ? params[params.length - 1].name : null;
		send({ field: 'add', paramType: 'Length', newName: makeUniqueName(), afterName });
	}

	function addGroup() {
		const afterName = params.length ? params[params.length - 1].name : null;
		send({ field: 'add', paramType: 'Title', newName: makeUniqueName('Gruppe'), afterName });
	}

	function addSeparator() {
		const afterName = params.length ? params[params.length - 1].name : null;
		send({ field: 'add', paramType: 'Separator', newName: makeUniqueName('Trennlinie'), afterName });
	}

	// Sendet erst bei Verlassen/Enter — nicht pro Tastendruck.
	function commitOnChange(input, fn) {
		let dirty = false;
		input.addEventListener('input', () => { dirty = true; });
		input.addEventListener('change', () => { if (dirty) { dirty = false; fn(); } });
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
	}

	function send(payload) { vscode.postMessage(Object.assign({ type: 'edit' }, payload)); }

	function flash(elm) { elm.classList.remove('saved'); void elm.offsetWidth; elm.classList.add('saved'); }

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}
	function iconBtn(label, title, fn) {
		const b = el('button', 'icon-btn', label);
		b.title = title;
		b.addEventListener('click', fn);
		return b;
	}
	function txtBtn(label, title, fn) {
		const b = el('button', 'array-toggle', label);
		b.title = title;
		b.addEventListener('click', fn);
		return b;
	}

	initColumns();
	vscode.postMessage({ type: 'ready' });
})();
