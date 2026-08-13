'use strict';

/**
 * Verlustfreier (whitespace-erhaltender) Parser/Serializer für das
 * LP_XMLConverter-Format der GDL paramlist.xml.
 *
 * Designziel: round-trip-Sicherheit. parse(text) -> serialize() liefert
 * für unveränderte Dokumente ein BYTE-IDENTISCHES Ergebnis (inkl. BOM,
 * Tabs, CDATA, Attribut-Reihenfolge, selbstschließende Tags, Zeilenenden).
 *
 * Strategie: Der Quelltext wird in rohe Tokens zerlegt (Text, Öffnungs-,
 * Schluss-, Selbstschluss-Tags, CDATA, Kommentare, Processing-Instructions).
 * Daraus entsteht ein Baum, in dem jedes Element seinen exakten rohen
 * Öffnungs-/Schlusstext behält. Serialisieren = rohe Stücke wieder
 * aneinanderhängen. Editieren ändert nur gezielt einzelne Knoten.
 */

// ── Übersetzung ───────────────────────────────────────────────────────────
// Der Datenkern kennt VS Code nicht (die Tests laufen in nacktem Node), holt
// sich die Übersetzung aber von außen: extension.js reicht `vscode.l10n`
// herein (setL10n). Ohne Haken bleiben die englischen Quelltexte stehen —
// {0}, {1}, … werden dann genau wie bei vscode.l10n.t ersetzt.
let l10n = {
	t(message, ...args) {
		if (!args.length) return message;
		return String(message).replace(/\{(\d+)\}/g,
			(m, i) => (args[i] !== undefined ? String(args[i]) : m));
	},
};
/** Übersetzer setzen (erwartet ein Objekt mit t(message, ...args)). */
function setL10n(impl) { if (impl && typeof impl.t === 'function') l10n = impl; }
const t = (message, ...args) => l10n.t(message, ...args);

const BOM = '﻿';

/** Knotentypen */
// element: { type:'element', name, rawOpen, selfClosing, children:[], rawClose }
// text:    { type:'text', raw }   (deckt Whitespace, gewöhnlichen Text ab)
// cdata:   { type:'cdata', raw }  (vollständig inkl. <![CDATA[ ... ]]>)
// comment: { type:'comment', raw }
// pi:      { type:'pi', raw }     (Processing Instruction, z.B. <?xml ...?>)

/**
 * Zerlegt den Quelltext (ohne BOM) in eine flache Tokenliste.
 */
function tokenize(s) {
	const tokens = [];
	let i = 0;
	const n = s.length;

	while (i < n) {
		const lt = s.indexOf('<', i);
		if (lt === -1) {
			// Restlicher reiner Text
			tokens.push({ type: 'text', raw: s.slice(i) });
			break;
		}
		if (lt > i) {
			tokens.push({ type: 'text', raw: s.slice(i, lt) });
		}

		if (s.startsWith('<![CDATA[', lt)) {
			const end = s.indexOf(']]>', lt);
			if (end === -1) throw new Error(t('Unterminated CDATA at offset {0}', lt));
			const raw = s.slice(lt, end + 3);
			tokens.push({ type: 'cdata', raw });
			i = end + 3;
			continue;
		}
		if (s.startsWith('<!--', lt)) {
			const end = s.indexOf('-->', lt);
			if (end === -1) throw new Error(t('Unterminated comment at offset {0}', lt));
			tokens.push({ type: 'comment', raw: s.slice(lt, end + 3) });
			i = end + 3;
			continue;
		}
		if (s.startsWith('<?', lt)) {
			const end = s.indexOf('?>', lt);
			if (end === -1) throw new Error(t('Unterminated PI at offset {0}', lt));
			tokens.push({ type: 'pi', raw: s.slice(lt, end + 2) });
			i = end + 2;
			continue;
		}
		if (s.startsWith('<!', lt)) {
			// DOCTYPE o.ä. – bis zum nächsten '>'
			const end = s.indexOf('>', lt);
			if (end === -1) throw new Error(t('Unterminated declaration at offset {0}', lt));
			tokens.push({ type: 'pi', raw: s.slice(lt, end + 1) });
			i = end + 1;
			continue;
		}

		// Normales Tag: bis zum '>' suchen, dabei Anführungszeichen respektieren
		let j = lt + 1;
		let quote = null;
		while (j < n) {
			const c = s[j];
			if (quote) {
				if (c === quote) quote = null;
			} else if (c === '"' || c === "'") {
				quote = c;
			} else if (c === '>') {
				break;
			}
			j++;
		}
		if (j >= n) throw new Error(t('Unterminated tag at offset {0}', lt));
		const rawTag = s.slice(lt, j + 1);
		i = j + 1;

		if (rawTag[1] === '/') {
			tokens.push({ type: 'close', raw: rawTag, name: tagName(rawTag) });
		} else if (rawTag[rawTag.length - 2] === '/') {
			tokens.push({ type: 'selfclose', raw: rawTag, name: tagName(rawTag) });
		} else {
			tokens.push({ type: 'open', raw: rawTag, name: tagName(rawTag) });
		}
	}
	return tokens;
}

/** Liest den Elementnamen aus einem rohen Tag-String. */
function tagName(rawTag) {
	// rawTag wie "<Length Name=...>" / "</Length>" / "<Fix/>"
	const m = /^<\/?\s*([^\s/>]+)/.exec(rawTag);
	return m ? m[1] : '';
}

/**
 * Baut aus der Tokenliste den Baum (Liste von Top-Level-Knoten).
 */
function buildTree(tokens) {
	const root = { type: 'root', children: [] };
	const stack = [root];

	// Laufvariable heißt `tok` (nicht `t`) — `t` ist der Übersetzer.
	for (const tok of tokens) {
		const parent = stack[stack.length - 1];
		switch (tok.type) {
			case 'open': {
				const el = {
					type: 'element',
					name: tok.name,
					rawOpen: tok.raw,
					selfClosing: false,
					children: [],
					rawClose: '',
				};
				parent.children.push(el);
				stack.push(el);
				break;
			}
			case 'selfclose': {
				parent.children.push({
					type: 'element',
					name: tok.name,
					rawOpen: tok.raw,
					selfClosing: true,
					children: [],
					rawClose: '',
				});
				break;
			}
			case 'close': {
				const el = stack.pop();
				if (!el || el.type !== 'element' || el.name !== tok.name) {
					throw new Error(el && el.name
						? t('Mismatched closing tag </{0}> (expected </{1}>)', tok.name, el.name)
						: t('Mismatched closing tag </{0}>', tok.name));
				}
				el.rawClose = tok.raw;
				break;
			}
			default:
				// text / cdata / comment / pi
				parent.children.push({ type: tok.type, raw: tok.raw });
		}
	}
	if (stack.length !== 1) {
		throw new Error(t('Unclosed element: {0}', stack[stack.length - 1].name || '?'));
	}
	return root;
}

/** Serialisiert einen Knoten (rekursiv) zurück zu rohem Text. */
function serializeNode(node) {
	switch (node.type) {
		case 'root':
			return node.children.map(serializeNode).join('');
		case 'element': {
			if (node.selfClosing) return node.rawOpen;
			return node.rawOpen + node.children.map(serializeNode).join('') + node.rawClose;
		}
		default:
			return node.raw;
	}
}

/**
 * Parst ein paramlist.xml.
 * @param {string} text Quelltext (mit oder ohne BOM)
 * @returns {{ bom:boolean, root:object }}
 */
function parse(text) {
	let bom = false;
	if (text.charCodeAt(0) === 0xfeff) {
		bom = true;
		text = text.slice(1);
	}
	const tokens = tokenize(text);
	const root = buildTree(tokens);
	return { bom, root };
}

/**
 * Serialisiert ein geparstes Dokument byte-genau zurück.
 * @param {{ bom:boolean, root:object }} doc
 * @returns {string}
 */
function serialize(doc) {
	return (doc.bom ? BOM : '') + serializeNode(doc.root);
}

// ──────────────────────────────────────────────────────────────────────────
// Typisierte Lese-/Editier-Schicht über dem verlustfreien Baum
// ──────────────────────────────────────────────────────────────────────────

/** Parameter-Typen, die ein editierbarer Parameter sind (keine Gruppe/Trenner). */
const VALUE_TYPES = new Set([
	'Length', 'Integer', 'RealNum', 'Angle', 'String', 'Boolean',
	'PenColor', 'LineType', 'FillPattern', 'Material', 'BuildingMaterial',
	'Profile', 'Dictionary',
]);

/** Liest ein Attribut aus einem rohen Öffnungs-Tag. */
function getAttr(rawOpen, attr) {
	const re = new RegExp('\\b' + attr + '\\s*=\\s*"([^"]*)"');
	const m = re.exec(rawOpen);
	return m ? m[1] : null;
}

/** Erstes Kind-Element mit gegebenem Namen. */
function childElement(el, name) {
	return el.children.find((c) => c.type === 'element' && c.name === name) || null;
}

/** Alle Kind-Elemente (ohne Text/Whitespace-Knoten). */
function childElements(el) {
	return el.children.filter((c) => c.type === 'element');
}

/** Innentext eines Elements (konkateniert text + cdata roh). */
function innerRaw(el) {
	if (!el) return '';
	return el.children
		.filter((c) => c.type === 'text' || c.type === 'cdata')
		.map((c) => c.raw)
		.join('');
}

/** Entfernt <![CDATA[ ]]>-Hülle, falls vorhanden. */
function stripCdata(s) {
	const m = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(s.trim());
	return m ? m[1] : s;
}

/** Entfernt umschließende doppelte Anführungszeichen, falls vorhanden. */
function stripQuotes(s) {
	const m = /^"([\s\S]*)"$/.exec(s);
	return m ? m[1] : s;
}

/**
 * GDL-String-Escaping: Innerhalb eines in "..." gefassten Strings wird ein
 * literales Anführungszeichen verdoppelt ("" ). `]]>` ist in CDATA nicht
 * darstellbar und wird abgelehnt.
 */
function escapeGdlStr(s) {
	s = String(s);
	if (s.indexOf(']]>') !== -1) throw new Error(t('The text must not contain the sequence "]]>".'));
	return s.replace(/"/g, '""');
}
/** Umkehrung von escapeGdlStr für die Anzeige. */
function unescapeGdlStr(s) {
	return String(s).replace(/""/g, '"');
}

/** Editier-Klasse eines Typs für die UI. */
function valueKindOf(type) {
	if (type === 'Boolean') return 'boolean';
	if (type === 'String') return 'string';
	if (type === 'Dictionary') return 'dict'; // <Value> ist ein Container, KEIN Skalar
	if (type === 'Length' || type === 'Integer' || type === 'RealNum' || type === 'Angle') return 'number';
	return 'index'; // PenColor, LineType, FillPattern, Material, BuildingMaterial, Profile
}

/** Findet das <Parameters>-Element im Dokument. */
function findParametersElement(doc) {
	const section = doc.root.children.find(
		(c) => c.type === 'element' && c.name === 'ParamSection'
	);
	if (!section) return null;
	return childElement(section, 'Parameters');
}

/**
 * Extrahiert die Parameterliste für die UI.
 * Jeder Eintrag referenziert seinen Baum-Knoten (`node`) für spätere Edits.
 */
function getParameters(doc) {
	const params = findParametersElement(doc);
	if (!params) return [];
	return childElements(params).map((el) => {
		const isTitle = el.name === 'Title';
		const isSeparator = el.name === 'Separator';
		const flagsEl = childElement(el, 'Flags');
		const flags = flagsEl ? childElements(flagsEl).map((f) => f.name) : [];
		const arr = childElement(el, 'ArrayValues');

		const descEl = childElement(el, 'Description');
		const valEl = childElement(el, 'Value');
		const rawValue = valEl ? innerRaw(valEl) : null;
		const kind = valueKindOf(el.name);

		// Editierbarer Klartext-Wert: String entkapseln (CDATA + Quotes + Escaping).
		let valueText = rawValue;
		if (rawValue !== null && kind === 'string') {
			valueText = unescapeGdlStr(stripQuotes(stripCdata(rawValue)));
		}

		return {
			node: el,
			type: el.name,
			name: getAttr(el.rawOpen, 'Name'),
			isTitle,
			isSeparator,
			isValue: VALUE_TYPES.has(el.name),
			valueKind: kind,
			fix: !!childElement(el, 'Fix'),
			flags,
			description: descEl ? unescapeGdlStr(stripQuotes(stripCdata(innerRaw(descEl)))) : null,
			value: rawValue,
			valueText,
			array: arr ? readArray(arr) : null,
		};
	});
}

/** Liest ein <ArrayValues>-Element in ein {first, second, values[]} aus. */
function readArray(arrEl) {
	const first = parseInt(getAttr(arrEl.rawOpen, 'FirstDimension') || '0', 10);
	const second = parseInt(getAttr(arrEl.rawOpen, 'SecondDimension') || '0', 10);
	const values = childElements(arrEl)
		.filter((c) => c.name === 'AVal')
		.map((c) => ({
			row: parseInt(getAttr(c.rawOpen, 'Row') || '0', 10),
			col: parseInt(getAttr(c.rawOpen, 'Column') || '0', 10),
			value: stripCdata(innerRaw(c)),
			node: c,
		}));
	return { first, second, values };
}

/**
 * Chirurgischer Edit: ersetzt den Innentext eines Elements durch genau einen
 * neuen Text-Knoten. Alles außerhalb der Tags bleibt byte-identisch.
 */
function setInner(el, rawText) {
	el.children = [{ type: 'text', raw: rawText }];
}

/** Macht aus einem (evtl. selbstschließenden) Element die offene Form <X>…</X>. */
function ensureOpenElement(el) {
	if (el.selfClosing) {
		el.selfClosing = false;
		el.rawOpen = el.rawOpen.replace(/\s*\/>$/, '>');
		el.rawClose = '</' + el.name + '>';
	}
}
/** Macht ein Element zum leeren, selbstschließenden Container <X/>. */
function makeEmptyElement(el) {
	el.selfClosing = true;
	el.rawOpen = el.rawOpen.replace(/\s*\/?>$/, '/>');
	el.rawClose = '';
	el.children = [];
}

/** Setzt den Wert (<Value>) eines Parameter-Knotens (roh, ohne Typformatierung). */
function setValue(paramNode, newValue) {
	const valEl = childElement(paramNode, 'Value');
	if (!valEl) throw new Error(t('Parameter has no <Value>: {0}', paramNode.name || '?'));
	setInner(valEl, String(newValue));
}

/**
 * Normalisiert einen numerischen Eingabewert für GDL/Archicad:
 *  - deutsches Dezimalkomma → Punkt (LP_XMLConverter akzeptiert NUR Punkt;
 *    ein Komma bricht die GESAMTE Parameter-Sektion ab → "Too many data"),
 *  - umschließende Leerzeichen entfernt.
 * Validiert das Ergebnis und wirft bei ungültiger Zahl. Integer- und Index-Typen
 * (PenColor, LineType, FillPattern, Material, BuildingMaterial, Profile, Dictionary)
 * erlauben nur Ganzzahlen.
 */
function normalizeNumber(type, text) {
	let s = String(text == null ? '' : text).trim().replace(/,/g, '.');
	const intOnly = type === 'Integer' || valueKindOf(type) === 'index';
	if (intOnly) {
		if (!/^-?\d+$/.test(s)) {
			throw new Error(t('"{0}" is not a whole number. {1} allows integers only.', text, type));
		}
	} else if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(s)) {
		throw new Error(t('"{0}" is not a valid number (allowed: digits and one decimal separator).', text));
	}
	return s;
}

/**
 * Setzt den Wert typgerecht: String wird als <![CDATA["..."]]> gespeichert,
 * Zahlen/Indizes normalisiert (Komma→Punkt, validiert), Boolean als "0"/"1".
 * `text` ist der Klartext-Wert (bei String ohne Anführungszeichen).
 */
function setValueByType(paramNode, type, text) {
	const valEl = childElement(paramNode, 'Value');
	if (!valEl) throw new Error(t('Parameter has no <Value>: {0}', paramNode.name || '?'));
	const kind = valueKindOf(type);
	// Dictionary: <Value> ist ein Container (leer <Value/> oder verschachtelte
	// Einträge). Ein skalarer Text (z.B. "0") wäre schema-ungültig und lässt den
	// LP_XMLConverter (x2l) die GANZE Datei ablehnen → kein skalares Setzen.
	if (kind === 'dict') return;
	ensureOpenElement(valEl);
	if (kind === 'string') {
		setInner(valEl, '<![CDATA["' + escapeGdlStr(text) + '"]]>');
	} else if (kind === 'number' || kind === 'index') {
		setInner(valEl, normalizeNumber(type, text));
	} else {
		setInner(valEl, String(text)); // boolean: "0"/"1"
	}
}

/**
 * Setzt die Beschreibung. GDL speichert Beschreibungen als CDATA mit
 * eingeschlossenem, in Anführungszeichen gesetztem String, z.B.
 * <![CDATA["Höhe"]]>. Übergib den reinen Text ohne Anführungszeichen.
 */
function setDescription(paramNode, text) {
	const descEl = childElement(paramNode, 'Description');
	if (!descEl) throw new Error(t('Parameter has no <Description>'));
	setInner(descEl, '<![CDATA["' + escapeGdlStr(text) + '"]]>');
}

// ──────────────────────────────────────────────────────────────────────────
// Strukturelle Edits (Name, Typ, Flags, Verschieben, Hinzufügen/Löschen, Arrays)
// ──────────────────────────────────────────────────────────────────────────

/** Bekannte Flag-Tags (außer Fix, das ein Geschwister-Element ist). */
const FLAG_TAGS = ['ParFlg_Hidden', 'ParFlg_BoldName', 'ParFlg_Unique', 'ParFlg_Child'];

function textNode(raw) { return { type: 'text', raw }; }
function selfCloseEl(name) {
	return { type: 'element', name, rawOpen: '<' + name + '/>', selfClosing: true, children: [], rawClose: '' };
}
function makeEl(name, children) {
	return { type: 'element', name, rawOpen: '<' + name + '>', selfClosing: false, children: children || [], rawClose: '</' + name + '>' };
}

/** Ermittelt die Einrückungsstrings eines Parameter-Knotens aus seinem Inhalt. */
function paramIndents(node) {
	const firstText = node.children.find((c) => c.type === 'text');
	const lead = firstText ? firstText.raw : '\n\t\t\t';
	const m = /\n(\t*)/.exec(lead);
	const tabs = m ? m[1] : '\t\t\t';
	const closeTabs = tabs.slice(1); // eine Ebene weniger für die schließenden Tags
	return { sub: '\n' + tabs, close: '\n' + closeTabs, flag: '\n' + tabs + '\t' };
}

/** Aktuelle Flag-Liste eines Knotens (in Datei-Reihenfolge). */
function currentFlags(node) {
	const flagsEl = childElement(node, 'Flags');
	return flagsEl ? childElements(flagsEl).map((f) => f.name) : [];
}

/** Text-Knoten, der unmittelbar vor `el` in `parent` steht (oder null). */
function precedingWs(parent, el) {
	const i = parent.children.indexOf(el);
	if (i > 0 && parent.children[i - 1].type === 'text') return parent.children[i - 1];
	return null;
}

/** Fügt [ws, newEl] direkt nach refEl ein; Einrückung wie vor refEl. */
function insertAfter(parent, refEl, newEl) {
	const i = parent.children.indexOf(refEl);
	const ws = precedingWs(parent, refEl);
	const wsRaw = ws ? ws.raw : '\n\t\t\t';
	parent.children.splice(i + 1, 0, textNode(wsRaw), newEl);
}

/** Entfernt ein Element samt seiner unmittelbar vorausgehenden Einrückung. */
function removeElementWithWs(parent, el) {
	const i = parent.children.indexOf(el);
	if (i < 0) return;
	if (i > 0 && parent.children[i - 1].type === 'text') parent.children.splice(i - 1, 2);
	else parent.children.splice(i, 1);
}

// HINWEIS: Es gibt bewusst KEIN setFix(). <Fix/> wird vom Subtype des Objekts
// bestimmt (externe Quelle) und darf nie über den Editor gesetzt oder entfernt
// werden — ein falsches Fix kann das GDL-Objekt zum Absturz bringen oder
// unkompilierbar machen. Der Editor liest Fix nur (blaue Zeile in der UI).

/**
 * Schaltet ein einzelnes Flag (ParFlg_*) an/aus — chirurgisch, erhält
 * Reihenfolge und alle übrigen Flags.
 */
function setFlag(node, flagTag, on) {
	if (!FLAG_TAGS.includes(flagTag)) throw new Error(t('Unknown flag: {0}', flagTag));
	let flagsEl = childElement(node, 'Flags');

	if (on) {
		if (!flagsEl) {
			flagsEl = makeEl('Flags');
			const { sub, flag } = paramIndents(node);
			flagsEl.children = [textNode(flag), selfCloseEl(flagTag), textNode(sub)];
			const ref = childElement(node, 'Fix') || childElement(node, 'Description');
			if (ref) insertAfter(node, ref, flagsEl);
			else node.children.unshift(textNode(sub), flagsEl);
			return;
		}
		if (childElements(flagsEl).some((f) => f.name === flagTag)) return;
		const existing = childElements(flagsEl)[0];
		const wsRaw = existing && precedingWs(flagsEl, existing)
			? precedingWs(flagsEl, existing).raw
			: '\n\t\t\t\t';
		const last = flagsEl.children[flagsEl.children.length - 1];
		const insertPos = last && last.type === 'text' ? flagsEl.children.length - 1 : flagsEl.children.length;
		flagsEl.children.splice(insertPos, 0, textNode(wsRaw), selfCloseEl(flagTag));
	} else {
		if (!flagsEl) return;
		const target = childElements(flagsEl).find((f) => f.name === flagTag);
		if (target) removeElementWithWs(flagsEl, target);
		if (childElements(flagsEl).length === 0) removeElementWithWs(node, flagsEl);
	}
}

/** Maximale Länge eines GDL-Parameternamens (Archicad-Limit). */
const MAX_NAME_LENGTH = 32;

/** Gültiger GDL-Parametername? (Buchstabe/_ am Anfang, dann alphanumerisch/_, max. 32 Zeichen) */
function isValidName(name) {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name || '') && name.length <= MAX_NAME_LENGTH;
}

/** Existiert der Name (case-insensitiv) bereits — außer am Knoten exceptNode? */
function nameExists(doc, name, exceptNode) {
	const paramsEl = findParametersElement(doc);
	if (!paramsEl) return false;
	const lower = String(name).toLowerCase();
	return childElements(paramsEl).some(
		(e) => e !== exceptNode && (getAttr(e.rawOpen, 'Name') || '').toLowerCase() === lower
	);
}

/** Benennt einen Parameter um (ändert nur das Name-Attribut). */
function setName(node, newName) {
	if (/Name\s*=\s*"/.test(node.rawOpen)) {
		node.rawOpen = node.rawOpen.replace(/(\bName\s*=\s*")[^"]*(")/, '$1' + newName + '$2');
	} else {
		// Kein Name-Attribut: vor dem schließenden > einfügen
		node.rawOpen = node.rawOpen.replace(/\s*\/?>$/, (m) =>
			' Name="' + newName + '"' + m.trimStart());
	}
}

/** Wandelt einen Klartextwert sinnvoll in den Zieltyp um. */
function normalizeForType(type, cur) {
	const kind = valueKindOf(type);
	if (kind === 'boolean') return cur === '1' || cur === 'true' ? '1' : '0';
	if (kind === 'string') return cur;
	// number / index
	if (/^-?\d+(\.\d+)?$/.test(cur)) return cur;
	return '0';
}

/** Ändert den Typ eines Parameters (Tag-Name) und passt das Wertformat an. */
function setType(node, newType) {
	const oldType = node.name;
	if (oldType === newType) return;
	node.rawOpen = node.rawOpen.replace(new RegExp('^<' + oldType + '\\b'), '<' + newType);
	if (!node.selfClosing) node.rawClose = '</' + newType + '>';
	node.name = newType;
	const valEl = childElement(node, 'Value');
	if (valEl) {
		if (valueKindOf(newType) === 'dict') {
			makeEmptyElement(valEl); // Dictionary-Wert ist ein leerer Container <Value/>
		} else {
			// von Dictionary (Container) kommend gibt es keinen sinnvollen Skalar → Default
			const cur = valueKindOf(oldType) === 'dict' ? '' : stripQuotes(stripCdata(innerRaw(valEl)));
			setValueByType(node, newType, normalizeForType(newType, cur));
		}
	}
}

// ── Parameter-Liste: Verschieben / Hinzufügen / Löschen ──
//
// Jeder Parameter wird als „Block" behandelt: das Element samt der ihm
// unmittelbar vorausgehenden Knoten (Einrückung, Kommentare, Leerzeilen).
// So bleiben Kommentar-Header und Leerzeilen beim Umsortieren erhalten.

/** Zerlegt <Parameters> in Blöcke + abschließende Knoten. */
function splitBlocks(paramsEl) {
	const blocks = [];
	let pending = [];
	for (const c of paramsEl.children) {
		if (c.type === 'element') { blocks.push({ lead: pending, el: c }); pending = []; }
		else pending.push(c);
	}
	return { blocks, trailing: pending };
}

function assembleBlocks(paramsEl, blocks, trailing) {
	const kids = [];
	for (const b of blocks) { for (const n of b.lead) kids.push(n); kids.push(b.el); }
	for (const n of trailing) kids.push(n);
	paramsEl.children = kids;
}

/** Reine Einrückung (ohne Kommentare) eines Parameters, z.B. "\n\t\t". */
function paramIndentWs(blocks) {
	for (const b of blocks) {
		const last = b.lead[b.lead.length - 1];
		if (last && last.type === 'text') {
			const m = /(\n\t*)$/.exec(last.raw);
			if (m) return m[1];
		}
	}
	return '\n\t\t';
}

/** Reihenfolge der Parameter anhand der Namensliste neu setzen (Blöcke wandern mit). */
function reorderParams(doc, orderedNames) {
	const paramsEl = findParametersElement(doc);
	if (!paramsEl) throw new Error(t('No <Parameters> element'));
	const { blocks, trailing } = splitBlocks(paramsEl);
	const byName = new Map(blocks.map((b) => [getAttr(b.el.rawOpen, 'Name'), b]));
	const ordered = orderedNames.map((n) => byName.get(n)).filter(Boolean);
	for (const b of blocks) if (!orderedNames.includes(getAttr(b.el.rawOpen, 'Name'))) ordered.push(b);
	assembleBlocks(paramsEl, ordered, trailing);
}

/** Verschiebt einen Parameter um delta Positionen (negativ = nach oben). */
function moveParam(doc, name, delta) {
	const paramsEl = findParametersElement(doc);
	const names = childElements(paramsEl).map((e) => getAttr(e.rawOpen, 'Name'));
	const i = names.indexOf(name);
	if (i < 0) return;
	const j = Math.max(0, Math.min(names.length - 1, i + delta));
	if (i === j) return;
	names.splice(j, 0, names.splice(i, 1)[0]);
	reorderParams(doc, names);
}

/** Löscht einen Parameter samt seines vorausgehenden Blocks (inkl. Kommentar). */
function deleteParam(doc, name) {
	deleteParams(doc, [name]);
}

/** Löscht mehrere Parameter samt ihrer Blöcke in EINEM Schritt (ein Undo). */
function deleteParams(doc, names) {
	const paramsEl = findParametersElement(doc);
	const { blocks, trailing } = splitBlocks(paramsEl);
	const gone = new Set(names);
	const kept = blocks.filter((b) => !gone.has(getAttr(b.el.rawOpen, 'Name')));
	assembleBlocks(paramsEl, kept, trailing);
}

/**
 * Dupliziert einen Parameter (inkl. Wert, Beschreibung, Flags, Fix, Arrays)
 * und fügt die Kopie direkt hinter dem Original ein. Die Kopie entsteht durch
 * erneutes Parsen des Roh-Texts des Originals — dadurch byte-identische
 * Struktur, nur das Name-Attribut wird ersetzt. Kommentare/Leerzeilen VOR dem
 * Original (dessen Block-Lead) werden bewusst nicht mitkopiert.
 */
function duplicateParam(doc, name, newName) {
	const paramsEl = findParametersElement(doc);
	if (!paramsEl) throw new Error(t('No <Parameters> element'));
	if (!isValidName(newName)) throw new Error(t('Invalid name: {0}', newName));
	if (nameExists(doc, newName, null)) throw new Error(t('Parameter name already exists: {0}', newName));
	const { blocks, trailing } = splitBlocks(paramsEl);
	const i = blocks.findIndex((b) => getAttr(b.el.rawOpen, 'Name') === name);
	if (i < 0) return null;
	const copy = buildTree(tokenize(serializeNode(blocks[i].el)))
		.children.find((c) => c.type === 'element');
	setName(copy, newName);
	// <Fix/> gilt nur für den vom Subtype vorgegebenen Namen — eine umbenannte
	// Kopie ist nicht Teil des Subtypes, ein kopiertes Fix wäre falsch/gefährlich.
	const fixEl = childElement(copy, 'Fix');
	if (fixEl) removeElementWithWs(copy, fixEl);
	blocks.splice(i + 1, 0, { lead: [textNode(paramIndentWs(blocks))], el: copy });
	assembleBlocks(paramsEl, blocks, trailing);
	return copy;
}

// ── Kopieren & Einfügen über Dateigrenzen (System-Zwischenablage) ──
//
// Kopieren serialisiert die gewählten Parameter als rohes XML-Fragment;
// Einfügen parst das Fragment und hängt die Elemente als neue Blöcke ein.
// Da das Fragment reines LP_XMLConverter-XML ist, funktioniert der Transfer
// zwischen beliebigen paramlist.xml-Dateien (auch über VS-Code-Fenster hinweg)
// und bleibt für Menschen im Texteditor lesbar.

/**
 * Serialisiert die Parameter mit den gegebenen Namen als XML-Fragment
 * (in Datei-Reihenfolge, mit Zeilenumbruch getrennt).
 */
function extractParamsXml(doc, names) {
	const paramsEl = findParametersElement(doc);
	if (!paramsEl) return '';
	const wanted = new Set(names.map((n) => String(n).toLowerCase()));
	return childElements(paramsEl)
		.filter((e) => wanted.has((getAttr(e.rawOpen, 'Name') || '').toLowerCase()))
		.map(serializeNode)
		.join('\n');
}

/**
 * Parst ein XML-Fragment (Zwischenablage) in Parameter-Elemente. Akzeptiert
 * auch eine komplette Datei bzw. Sektion (steigt in <ParamSection> /
 * <Parameters> ab). Liefert [], wenn der Text keine reine Parameterliste ist.
 */
function parseParamFragments(text) {
	let s = String(text || '');
	if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
	if (!/^\s*</.test(s)) return [];
	let root;
	try { root = buildTree(tokenize(s)); } catch (e) { return []; }
	let els = root.children.filter((c) => c.type === 'element');
	if (els.length === 1 && els[0].name === 'ParamSection') els = [childElement(els[0], 'Parameters')].filter(Boolean);
	if (els.length === 1 && els[0].name === 'Parameters') els = childElements(els[0]);
	const isParam = (e) =>
		(VALUE_TYPES.has(e.name) || e.name === 'Title' || e.name === 'Separator') &&
		!!getAttr(e.rawOpen, 'Name');
	return els.length > 0 && els.every(isParam) ? els : [];
}

/**
 * Fügt kopierte Parameter-Elemente nach `afterName` ein (null = am Ende).
 * Kollidierende Namen werden eindeutig gemacht (_copy, _copy2, …, unter
 * Einhaltung des 32-Zeichen-Limits); <Fix/> wird entfernt — es gilt nur für
 * den Subtype der QUELL-Datei und wäre in der Zieldatei falsch/gefährlich.
 * Liefert die tatsächlich vergebenen Namen.
 */
function insertParams(doc, els, afterName) {
	const paramsEl = findParametersElement(doc);
	if (!paramsEl) throw new Error(t('No <Parameters> element'));
	const { blocks, trailing } = splitBlocks(paramsEl);
	const indent = paramIndentWs(blocks);
	const taken = new Set(blocks.map((b) => (getAttr(b.el.rawOpen, 'Name') || '').toLowerCase()));
	let pos = blocks.length;
	if (afterName) {
		const i = blocks.findIndex((b) => getAttr(b.el.rawOpen, 'Name') === afterName);
		if (i >= 0) pos = i + 1;
	}
	const used = [];
	for (const src of els) {
		// Frisch parsen → unabhängige Knoten (auch bei mehrfachem Einfügen).
		const el = buildTree(tokenize(serializeNode(src))).children.find((c) => c.type === 'element');
		let base = getAttr(el.rawOpen, 'Name');
		if (!isValidName(base)) base = 'param';
		const mk = (suffix) => base.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
		let name = base;
		for (let n = 1; taken.has(name.toLowerCase()); n++) name = mk(n === 1 ? '_copy' : '_copy' + n);
		if (name !== getAttr(el.rawOpen, 'Name')) setName(el, name);
		taken.add(name.toLowerCase());
		const fixEl = childElement(el, 'Fix');
		if (fixEl) removeElementWithWs(el, fixEl);
		blocks.splice(pos++, 0, { lead: [textNode(indent)], el });
		used.push(name);
	}
	assembleBlocks(paramsEl, blocks, trailing);
	return used;
}

/**
 * Fügt einen neuen Parameter nach `afterName` ein (oder am Ende, wenn null).
 * Erzeugt einen minimalen, gültigen Knoten passend zum Typ.
 */
function addParam(doc, { type, name, afterName }) {
	const paramsEl = findParametersElement(doc);
	if (!paramsEl) throw new Error(t('No <Parameters> element'));
	if (childElements(paramsEl).some((e) => (getAttr(e.rawOpen, 'Name') || '').toLowerCase() === name.toLowerCase())) {
		throw new Error(t('Parameter name already exists: {0}', name));
	}
	const { blocks, trailing } = splitBlocks(paramsEl);
	const indent = paramIndentWs(blocks);          // z.B. "\n\t\t"
	const sub = indent + '\t';                      // Kinder eine Ebene tiefer

	// Strukturzeilen (Title = Gruppen-Überschrift, Separator = Trennbalken)
	// tragen nur eine <Description> und KEINEN <Value>.
	const isStructural = type === 'Title' || type === 'Separator';
	const node = {
		type: 'element', name: type, selfClosing: false, children: [],
		rawOpen: '<' + type + ' Name="' + name + '">', rawClose: '</' + type + '>',
	};
	node.children.push(textNode(sub), makeEl('Description', [textNode('<![CDATA[""]]>')]));
	if (!isStructural) {
		const kind = valueKindOf(type);
		// Dictionary: leerer Container <Value/> (Skalar wäre schema-ungültig).
		const valEl = kind === 'dict'
			? selfCloseEl('Value')
			: makeEl('Value', [textNode(kind === 'string' ? '<![CDATA[""]]>' : '0')]);
		node.children.push(textNode(sub), valEl);
	}
	node.children.push(textNode(indent));

	const newBlock = { lead: [textNode(indent)], el: node };
	const names = blocks.map((b) => getAttr(b.el.rawOpen, 'Name'));
	const pos = afterName ? names.indexOf(afterName) + 1 : blocks.length;
	blocks.splice(pos, 0, newBlock);
	assembleBlocks(paramsEl, blocks, trailing);
	return node;
}

// ── Arrays ──

/** Setzt den Wert einer Array-Zelle (row/col 1-basiert). String-Typ → CDATA-Quotes,
 *  Zahlen/Indizes normalisiert (Komma→Punkt, validiert) wie skalare Werte. */
function setArrayCell(paramNode, row, col, text) {
	const arrEl = childElement(paramNode, 'ArrayValues');
	if (!arrEl) throw new Error(t('Parameter has no <ArrayValues>'));
	const kind = valueKindOf(paramNode.name);
	const target = childElements(arrEl).find((c) =>
		c.name === 'AVal' &&
		parseInt(getAttr(c.rawOpen, 'Row') || '0', 10) === row &&
		parseInt(getAttr(c.rawOpen, 'Column') || '0', 10) === col
	);
	if (!target) throw new Error(t('Array cell not found: {0}/{1}', row, col));
	if (kind === 'string') setInner(target, '<![CDATA["' + escapeGdlStr(text) + '"]]>');
	else if (kind === 'number' || kind === 'index') setInner(target, normalizeNumber(paramNode.name, text));
	else setInner(target, String(text));
}

// ── Array-Struktur (Zeilen/Spalten, Dimension, anlegen/entfernen) ──

function buildAval(second, r, c, rawInner) {
	const attrs = second > 0 ? 'Column="' + c + '" Row="' + r + '"' : 'Row="' + r + '"';
	return { type: 'element', name: 'AVal', selfClosing: false,
		rawOpen: '<AVal ' + attrs + '>', rawClose: '</AVal>', children: [textNode(rawInner)] };
}

/** Einrückung des Arrays (AVal-Ebene + schließende Ebene) aus dem Bestand ableiten. */
function arrayIndents(node, arrEl) {
	if (arrEl) {
		const firstAval = childElements(arrEl).find((c) => c.name === 'AVal');
		const aw = firstAval ? precedingWs(arrEl, firstAval) : null;
		const last = arrEl.children[arrEl.children.length - 1];
		if (aw && last && last.type === 'text') return { aval: aw.raw, close: last.raw };
	}
	const { sub } = paramIndents(node);
	return { aval: sub + '\t', close: sub };
}

function defaultCell(type) {
	return valueKindOf(type) === 'string' ? '<![CDATA[""]]>' : '0';
}

/** Liest Array-Zellen als Map "r:c" -> rawInner (c=1 bei 1D). */
function readArrayCells(arrEl) {
	const map = new Map();
	for (const av of childElements(arrEl)) {
		if (av.name !== 'AVal') continue;
		const r = parseInt(getAttr(av.rawOpen, 'Row') || '0', 10);
		const c = parseInt(getAttr(av.rawOpen, 'Column') || '0', 10) || 1;
		map.set(r + ':' + c, innerRaw(av));
	}
	return map;
}

/** Dichter Neuaufbau (nur für FRISCH angelegte Arrays, nicht für vorhandene!). */
function writeArrayDense(node, arrEl, first, second) {
	const type = node.name;
	const { aval, close } = arrayIndents(node, arrEl);
	const outCols = second > 0 ? second : 1;
	const kids = [];
	for (let r = 1; r <= first; r++)
		for (let c = 1; c <= outCols; c++) {
			kids.push(textNode(aval));
			kids.push(buildAval(second, r, c, defaultCell(type)));
		}
	kids.push(textNode(close));
	arrEl.children = kids;
	arrEl.rawOpen = arrEl.rawOpen
		.replace(/FirstDimension="\d+"/, 'FirstDimension="' + first + '"')
		.replace(/SecondDimension="\d+"/, 'SecondDimension="' + second + '"');
}

function arrDim(arrEl, which) {
	return parseInt(getAttr(arrEl.rawOpen, which + 'Dimension') || '0', 10);
}
function setArrDim(arrEl, which, val) {
	arrEl.rawOpen = arrEl.rawOpen.replace(
		new RegExp(which + 'Dimension="\\d+"'), which + 'Dimension="' + val + '"');
}
/** Schreibt Row/Column-Attribute eines AVal neu (Inhalt bleibt). */
function setAvalCoords(av, second, r, c) {
	av.rawOpen = second > 0 ? '<AVal Column="' + c + '" Row="' + r + '">' : '<AVal Row="' + r + '">';
}
/** Fügt [ws, el] vor dem schließenden Text-Knoten von parent ein. */
function appendBeforeClose(parent, ws, el) {
	const last = parent.children[parent.children.length - 1];
	const pos = last && last.type === 'text' ? parent.children.length - 1 : parent.children.length;
	parent.children.splice(pos, 0, textNode(ws), el);
}

/** Hängt eine Zeile am Ende an (chirurgisch — vorhandene Zellen unberührt). */
function addArrayRow(node) {
	const arrEl = childElement(node, 'ArrayValues');
	if (!arrEl) throw new Error(t('Parameter has no <ArrayValues>'));
	const first = arrDim(arrEl, 'First'), second = arrDim(arrEl, 'Second');
	const { aval } = arrayIndents(node, arrEl);
	const cols = second > 0 ? second : 1;
	for (let c = 1; c <= cols; c++)
		appendBeforeClose(arrEl, aval, buildAval(second, first + 1, c, defaultCell(node.name)));
	setArrDim(arrEl, 'First', first + 1);
}

/** Entfernt eine bestimmte Zeile (1-basiert) und nummeriert höhere Zeilen nach. */
function removeArrayRow(node, row) {
	const arrEl = childElement(node, 'ArrayValues');
	if (!arrEl) throw new Error(t('Parameter has no <ArrayValues>'));
	const first = arrDim(arrEl, 'First'), second = arrDim(arrEl, 'Second');
	if (first <= 1) throw new Error(t('The last row cannot be removed.'));
	for (const av of childElements(arrEl).filter((a) => a.name === 'AVal')) {
		const r = parseInt(getAttr(av.rawOpen, 'Row') || '0', 10);
		if (r === row) removeElementWithWs(arrEl, av);
		else if (r > row) setAvalCoords(av, second, r - 1, parseInt(getAttr(av.rawOpen, 'Column') || '0', 10));
	}
	setArrDim(arrEl, 'First', first - 1);
}

/** Hängt eine Spalte am Ende an. Bei 1D wird das Array zuerst in 2D umgewandelt. */
function addArrayCol(node) {
	const arrEl = childElement(node, 'ArrayValues');
	if (!arrEl) throw new Error(t('Parameter has no <ArrayValues>'));
	const second = arrDim(arrEl, 'Second');
	if (second <= 0) {
		// 1D → 2D: jede vorhandene Zelle wird Spalte 1, dahinter eine neue Spalte 2.
		for (const av of childElements(arrEl).filter((a) => a.name === 'AVal')) {
			const r = parseInt(getAttr(av.rawOpen, 'Row') || '0', 10);
			setAvalCoords(av, 2, r, 1);
			insertAfter(arrEl, av, buildAval(2, r, 2, defaultCell(node.name)));
		}
		setArrDim(arrEl, 'Second', 2);
		return;
	}
	const newCol = second + 1;
	// In jeder Zeile nach der bisher letzten Spalte eine Zelle einfügen.
	const lastInRow = childElements(arrEl).filter((a) =>
		a.name === 'AVal' && parseInt(getAttr(a.rawOpen, 'Column') || '0', 10) === second);
	for (const ref of lastInRow) {
		const r = parseInt(getAttr(ref.rawOpen, 'Row') || '0', 10);
		insertAfter(arrEl, ref, buildAval(second, r, newCol, defaultCell(node.name)));
	}
	setArrDim(arrEl, 'Second', newCol);
}

/** Entfernt eine bestimmte Spalte (2D); bei nur noch 1 Spalte → 1D. */
function removeArrayCol(node, col) {
	const arrEl = childElement(node, 'ArrayValues');
	if (!arrEl) throw new Error(t('Parameter has no <ArrayValues>'));
	const second = arrDim(arrEl, 'Second');
	if (second <= 1) throw new Error(t('Column cannot be removed (not a 2D array).'));
	const newSecond = second - 1 <= 1 ? 0 : second - 1;
	for (const av of childElements(arrEl).filter((a) => a.name === 'AVal')) {
		const c = parseInt(getAttr(av.rawOpen, 'Column') || '0', 10);
		const r = parseInt(getAttr(av.rawOpen, 'Row') || '0', 10);
		if (c === col) removeElementWithWs(arrEl, av);
		else setAvalCoords(av, newSecond, r, c > col ? c - 1 : c);
	}
	setArrDim(arrEl, 'Second', newSecond);
}

/** Wandelt einen skalaren Parameter in ein Array (ersetzt <Value> durch <ArrayValues>). */
function createArray(node, rows, cols) {
	if (childElement(node, 'ArrayValues')) return childElement(node, 'ArrayValues');
	const r = Math.max(1, rows | 0), c = Math.max(0, cols | 0);
	const valEl = childElement(node, 'Value');
	const arrEl = { type: 'element', name: 'ArrayValues', selfClosing: false,
		rawOpen: '<ArrayValues FirstDimension="' + r + '" SecondDimension="' + c + '">',
		rawClose: '</ArrayValues>', children: [] };
	if (valEl) { node.children[node.children.indexOf(valEl)] = arrEl; }
	else { insertAfter(node, childElement(node, 'Description') || node.children[0], arrEl); }
	writeArrayDense(node, arrEl, r, c);
	return arrEl;
}

/** Wandelt ein Array zurück in einen skalaren Parameter (ersetzt <ArrayValues> durch <Value>). */
function removeArray(node) {
	const arrEl = childElement(node, 'ArrayValues');
	if (!arrEl) return;
	const valEl = makeEl('Value', [textNode(defaultCell(node.name))]);
	node.children[node.children.indexOf(arrEl)] = valEl;
}

module.exports = {
	parse, serialize, tagName, BOM, setL10n,
	VALUE_TYPES, FLAG_TAGS, valueKindOf, getParameters, findParametersElement,
	childElement, childElements, getAttr, innerRaw, stripCdata, stripQuotes, readArray,
	escapeGdlStr, unescapeGdlStr, normalizeNumber,
	setInner, setValue, setValueByType, setDescription,
	currentFlags, setFlag, setName, setType, normalizeForType,
	reorderParams, moveParam, deleteParam, deleteParams, addParam, duplicateParam, setArrayCell,
	extractParamsXml, parseParamFragments, insertParams,
	isValidName, nameExists, MAX_NAME_LENGTH,
	addArrayRow, removeArrayRow, addArrayCol, removeArrayCol, createArray, removeArray, readArrayCells,
};
