'use strict';

// Webview-Frontend des GDL Parameter Editors.
// Kommuniziert per postMessage mit dem Extension-Host (kein REST, keine DB).

(function () {
	const vscode = acquireVsCodeApi();

	const listEl = document.getElementById('list');
	const filterEl = document.getElementById('filter');
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

	const FLAG_DEFS = [
		{ key: 'fix', label: 'Fix', title: 'Fix (Wert beim Platzieren fixiert)' },
		{ key: 'hidden', label: 'H', title: 'Versteckt (ParFlg_Hidden)', flag: 'ParFlg_Hidden' },
		{ key: 'bold', label: 'B', title: 'Fett (ParFlg_BoldName)', flag: 'ParFlg_BoldName' },
		{ key: 'unique', label: 'U', title: 'Eindeutig (ParFlg_Unique)', flag: 'ParFlg_Unique' },
		{ key: 'child', label: 'C', title: 'Untergeordnet/eingerückt (ParFlg_Child)', flag: 'ParFlg_Child' },
	];

	let params = [];
	let dragName = null; // aktuell gezogener Parameter (Drag & Drop)
	const expanded = new Set(); // Namen der aufgeklappten Array-Parameter

	// ── Client-seitige Validierung (Spiegel der Datenkern-Regeln, nur für
	//    sofortiges Feedback; der Extension-Host bleibt die maßgebliche Prüfung) ──
	const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // keine Ziffer am Anfang, keine
	// Leer-/Sonderzeichen außer _, keine Umlaute/ß
	function isValidNameC(n) { return NAME_RE.test(n || ''); }

	const INDEX_TYPES = new Set(['PenColor', 'LineType', 'FillPattern', 'Material', 'BuildingMaterial', 'Profile', 'Dictionary']);
	// Liefert {ok, value} — value ist die normalisierte Zahl (Komma→Punkt).
	function normNumberC(type, text) {
		const s = String(text == null ? '' : text).trim().replace(/,/g, '.');
		const intOnly = type === 'Integer' || INDEX_TYPES.has(type);
		const re = intOnly ? /^-?\d+$/ : /^-?(?:\d+\.?\d*|\.\d+)$/;
		return { ok: re.test(s), value: s, intOnly };
	}

	const NAME_RULE = 'Erlaubt: Buchstaben, Ziffern und _ — Beginn mit Buchstabe oder _, ' +
		'keine Leerzeichen, keine Umlaute/ß, keine sonstigen Sonderzeichen.';

	// Verdrahtet ein Namens-Eingabefeld: Live-Markierung ungültiger Zeichen +
	// Prüfung beim Verlassen (ungültig → Hinweis, Feld auf Wahrheit zurück).
	function wireNameInput(input, p) {
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
		}
	});

	function showNotice(text) {
		noticeEl.hidden = false;
		noticeEl.textContent = '⚠ ' + text;
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => { noticeEl.hidden = true; }, 5000);
	}

	filterEl.addEventListener('input', render);
	addBtn.addEventListener('click', addParam);
	document.getElementById('addGroupBtn').addEventListener('click', addGroup);
	document.getElementById('addSeparatorBtn').addEventListener('click', addSeparator);

	function render() {
		const q = filterEl.value.trim().toLowerCase();
		listEl.textContent = '';
		let shown = 0;
		for (const p of params) {
			if (q && !matches(p, q)) continue;
			shown++;
			if (p.isSeparator) { listEl.appendChild(renderSeparator(p)); continue; }
			if (p.isTitle) { listEl.appendChild(renderTitle(p)); continue; }
			listEl.appendChild(renderParam(p));
			if (p.isArray && expanded.has(p.name)) listEl.appendChild(renderArrayPanel(p));
		}
		countEl.textContent = shown + ' / ' + params.length + ' Parameter';
	}

	function matches(p, q) {
		return (p.name && p.name.toLowerCase().includes(q)) ||
			(p.description && p.description.toLowerCase().includes(q));
	}

	function renderTitle(p) {
		const row = el('div', 'row title');
		row.appendChild(renderControls(p));

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

		makeRowDroppable(row, p);
		return row;
	}

	// Trennbalken (Separator): nur interner Name + Trennlinie, KEIN Überschriften-Text.
	function renderSeparator(p) {
		const row = el('div', 'row separator');
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

		makeRowDroppable(row, p);
		return row;
	}

	function renderParam(p) {
		const row = el('div', 'row' + (p.child ? ' child' : '') + (p.hidden ? ' hidden' : ''));

		row.appendChild(renderControls(p));

		// Typ-Dropdown
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

		// Name (editierbar)
		const name = document.createElement('input');
		name.type = 'text';
		name.className = 'pname' + (p.bold ? ' bold' : '');
		name.value = p.name || '';
		wireNameInput(name, p);
		row.appendChild(name);

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

		// Flags
		row.appendChild(renderFlags(p));
		makeRowDroppable(row, p);
		return row;
	}

	function renderControls(p) {
		const c = el('span', 'controls');
		const handle = el('span', 'drag-handle', '⠿');
		handle.title = 'Ziehen zum Verschieben';
		handle.draggable = true;
		handle.addEventListener('dragstart', (e) => {
			dragName = p.name;
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', p.name);
		});
		handle.addEventListener('dragend', () => { dragName = null; });
		c.appendChild(handle);
		c.appendChild(iconBtn('▲', 'Nach oben', () => send({ field: 'move', name: p.name, delta: -1 })));
		c.appendChild(iconBtn('▼', 'Nach unten', () => send({ field: 'move', name: p.name, delta: 1 })));
		c.appendChild(iconBtn('＋', 'Neuen Parameter unter diesem einfügen', () =>
			send({ field: 'add', paramType: 'Length', newName: makeUniqueName(), afterName: p.name })));
		c.appendChild(iconBtn('🗑', 'Löschen (rückgängig mit Cmd+Z)', () => send({ field: 'delete', name: p.name })));
		return c;
	}

	function makeUniqueName(base) {
		base = base || 'neuerParameter';
		const existing = new Set(params.map((p) => (p.name || '').toLowerCase()));
		let n = 1, name;
		do { name = base + n++; } while (existing.has(name.toLowerCase()));
		return name;
	}

	// ── Drag & Drop: Zeile auf eine andere ziehen → davor einsortieren ──
	function makeRowDroppable(row, p) {
		row.addEventListener('dragover', (e) => {
			if (!dragName || dragName === p.name) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			row.classList.add('drop-target');
		});
		row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
		row.addEventListener('drop', (e) => {
			e.preventDefault();
			row.classList.remove('drop-target');
			if (dragName && dragName !== p.name) reorderTo(dragName, p.name);
		});
	}
	function reorderTo(fromName, beforeName) {
		const names = params.map((p) => p.name);
		const fi = names.indexOf(fromName);
		if (fi < 0) return;
		names.splice(fi, 1);
		const bi = names.indexOf(beforeName);
		names.splice(bi < 0 ? names.length : bi, 0, fromName);
		send({ field: 'reorder', names });
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
			return wrap;
		}
		if (p.valueKind === 'dict') {
			// Dictionary: <Value> ist ein Container, nicht skalar editierbar.
			// Hier nur anzeigen (Einträge werden im Editor derzeit nicht bearbeitet).
			const badge = el('span', 'dict-badge', 'Dictionary');
			badge.title = 'Dictionary-Inhalt wird hier nicht skalar bearbeitet (Container).';
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
		wrap.appendChild(iconBtn('⊞', 'In Array umwandeln', () => {
			expanded.add(p.name);
			send({ field: 'arrayCreate', name: p.name, rows: 1, cols: 0 });
		}));
		return wrap;
	}

	function renderFlags(p) {
		const box = el('span', 'flags');
		for (const f of FLAG_DEFS) {
			const active = !!p[f.key];
			const chip = el('button', 'chip' + (active ? ' active' : ''), f.label);
			chip.title = f.title;
			chip.addEventListener('click', () => {
				if (f.key === 'fix') send({ field: 'fix', name: p.name, value: !active });
				else send({ field: 'flag', name: p.name, flag: f.flag, value: !active });
			});
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

		const bar = el('div', 'array-bar');
		bar.appendChild(el('span', 'muted', is2D ? (a.first + ' × ' + a.second) : (a.first + ' Zeilen (1D)')));
		bar.appendChild(txtBtn('+ Zeile', 'Zeile am Ende anhängen', () => send({ field: 'arrayAddRow', name: p.name })));
		bar.appendChild(txtBtn('+ Spalte', is2D ? 'Spalte anhängen' : 'In 2D umwandeln (Spalte hinzufügen)', () => send({ field: 'arrayAddCol', name: p.name })));
		bar.appendChild(txtBtn('Kein Array', 'In skalaren Wert zurückwandeln', () => send({ field: 'arrayRemove', name: p.name })));
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
				const inp = document.createElement('input');
				inp.type = 'text';
				inp.className = 'val ' + p.valueKind;
				const v = map.get(r + ':' + c);
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

	vscode.postMessage({ type: 'ready' });
})();
