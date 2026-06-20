'use strict';

/**
 * Sicherheitsnetz für strukturelle Edits (Flags, Fix, Name, Typ, Move, Add, Delete).
 *
 * Kernidee: Operationen, die nichts ändern (rebuild im Ist-Zustand,
 * reorder in Ist-Reihenfolge, Flag an+aus), müssen das Dokument
 * BYTE-IDENTISCH lassen. Echte Änderungen werden auf Korrektheit re-geparst.
 *
 * Aufruf:  node test/structure.js [SUCHWURZEL]
 */

const fs = require('fs');
const path = require('path');
const P = require('../src/paramlist');

const ROOT = process.argv[2] || '/Users/Jochen/Documents/1_GDL_DEVELOP';

function findParamFiles(dir, out) {
	out = out || [];
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === '.git' || e.name === 'node_modules') continue;
			findParamFiles(full, out);
		} else if (e.isFile() && /^(paramlist|Parameters)\.xml$/i.test(e.name)) {
			out.push(full);
		}
	}
	return out;
}

let fails = 0;
function check(cond, msg) { if (!cond) { console.log('  ✗ ' + msg); fails++; } }

function main() {
	const files = findParamFiles(ROOT);
	console.log('Dateien: ' + files.length + '\n');

	let reorderOk = 0, flagOk = 0;

	for (const file of files) {
		const original = fs.readFileSync(file, 'utf8');

		// 2) reorder in Ist-Reihenfolge → byte-identisch
		{
			const doc = P.parse(original);
			const names = P.getParameters(doc).map((p) => p.name);
			P.reorderParams(doc, names);
			if (P.serialize(doc) === original) reorderOk++;
			else check(false, 'reorder(identisch) ändert Bytes: ' + path.relative(ROOT, file));
		}

		// 3) Flag an+aus → byte-identisch; und Flag-Zustand korrekt re-geparst
		{
			const doc = P.parse(original);
			const params = P.getParameters(doc);
			const victim = params.find((p) => !p.isTitle && p.value !== null);
			if (victim) {
				const had = P.currentFlags(victim.node).includes('ParFlg_Hidden');
				P.setFlag(victim.node, 'ParFlg_Hidden', !had);
				const mid = P.getParameters(P.parse(P.serialize(doc))).find((p) => p.name === victim.name);
				check(mid.flags.includes('ParFlg_Hidden') === !had, 'Flag-Toggle wirkt (' + victim.name + ')');
				// zurück
				const v2 = P.getParameters(doc).find((p) => p.name === victim.name);
				P.setFlag(v2.node, 'ParFlg_Hidden', had);
				if (P.serialize(doc) === original) flagOk++;
				else check(false, 'Flag an+aus nicht byte-identisch: ' + path.relative(ROOT, file));
			} else { flagOk++; }
		}
	}

	// 4) Funktionale Korrektheit an einer Datei
	{
		const file = files.find((f) => P.getParameters(P.parse(fs.readFileSync(f, 'utf8'))).some((p) => p.isValue));
		const original = fs.readFileSync(file, 'utf8');
		const doc = P.parse(original);
		const params = P.getParameters(doc);
		const v = params.find((p) => p.isValue && !p.array);

		// Rename
		P.setName(v.node, 'umbenannt_xyz');
		check(P.getAttr(v.node.rawOpen, 'Name') === 'umbenannt_xyz', 'setName wirkt');

		// Typ ändern Length->Integer
		const lenP = P.getParameters(P.parse(original)).find((p) => p.type === 'Length');
		if (lenP) {
			const d2 = P.parse(original);
			const lp = P.getParameters(d2).find((p) => p.name === lenP.name);
			P.setType(lp.node, 'Integer');
			const re = P.getParameters(P.parse(P.serialize(d2))).find((p) => p.name === lenP.name);
			check(re.type === 'Integer', 'setType Length->Integer');
		}

		// Add + Delete
		const d3 = P.parse(original);
		const before = P.getParameters(d3).filter((p) => !p.isTitle).length;
		P.addParam(d3, { type: 'Boolean', name: 'neu_bool_param', afterName: null });
		const added = P.getParameters(P.parse(P.serialize(d3)));
		check(added.some((p) => p.name === 'neu_bool_param' && p.type === 'Boolean'), 'addParam fügt ein');
		P.deleteParam(d3, 'neu_bool_param');
		check(P.serialize(d3) === original, 'addParam+deleteParam ergibt Original');

		// Move
		const d4 = P.parse(original);
		const ns = P.getParameters(d4).map((p) => p.name);
		if (ns.length >= 2) {
			P.moveParam(d4, ns[1], -1);
			const after = P.getParameters(P.parse(P.serialize(d4))).map((p) => p.name);
			check(after[0] === ns[1] && after[1] === ns[0], 'moveParam(-1) tauscht');
		}

		// Eindeutigkeit / Namensvalidierung
		const d5 = P.parse(original);
		const all = P.getParameters(d5);
		if (all.length >= 2) {
			const a = all[0], b = all[1];
			check(P.nameExists(d5, b.name, null) === true, 'nameExists erkennt vorhandenen Namen');
			check(P.nameExists(d5, b.name.toUpperCase(), null) === true, 'nameExists ist case-insensitiv');
			check(P.nameExists(d5, b.name, b.node) === false, 'nameExists ignoriert den eigenen Knoten');
			check(P.nameExists(d5, '____garantiert_neu____', null) === false, 'nameExists: neuer Name frei');
		}
		check(P.isValidName('gut_1') === true, 'isValidName akzeptiert gültigen Namen');
		check(P.isValidName('1schlecht') === false, 'isValidName lehnt Ziffer-Beginn ab');
		check(P.isValidName('mit leer') === false, 'isValidName lehnt Leerzeichen ab');
		check(P.isValidName('') === false, 'isValidName lehnt leer ab');
		check(P.isValidName('Höhe') === false, 'isValidName lehnt Umlaut ab');
		check(P.isValidName('strasse_ß') === false, 'isValidName lehnt ß ab');
		check(P.isValidName('a-b') === false, 'isValidName lehnt Sonderzeichen ab');
		check(P.isValidName('_intern2') === true, 'isValidName akzeptiert _-Beginn und Ziffer im Wort');

		// Numerische Normalisierung (Komma→Punkt) — verhindert LP_XMLConverter-Abbruch
		check(P.normalizeNumber('RealNum', '3,1415') === '3.1415', 'normalizeNumber RealNum Komma→Punkt');
		check(P.normalizeNumber('Length', '1,5') === '1.5', 'normalizeNumber Length Komma→Punkt');
		check(P.normalizeNumber('Angle', ' 45 ') === '45', 'normalizeNumber trimmt');
		check(P.normalizeNumber('Integer', '42') === '42', 'normalizeNumber Integer ok');
		let nThrew = false; try { P.normalizeNumber('Integer', '3,5'); } catch { nThrew = true; }
		check(nThrew, 'normalizeNumber lehnt Dezimal bei Integer ab');
		nThrew = false; try { P.normalizeNumber('RealNum', 'abc'); } catch { nThrew = true; }
		check(nThrew, 'normalizeNumber lehnt Nicht-Zahl ab');
		nThrew = false; try { P.normalizeNumber('PenColor', '1.5'); } catch { nThrew = true; }
		check(nThrew, 'normalizeNumber lehnt Dezimal bei Index-Typ ab');

		// Dictionary: muss leeren Container <Value/> erzeugen, KEIN <Value>0</Value>
		// (skalarer Text in Dictionary-<Value> ist schema-ungültig → x2l lehnt Datei ab)
		check(P.valueKindOf('Dictionary') === 'dict', 'valueKindOf Dictionary = dict');
		const dDict = P.parse(original);
		P.addParam(dDict, { type: 'Dictionary', name: 'neu_dict_param', afterName: null });
		const dictXml = P.serialize(dDict);
		check(/<Dictionary Name="neu_dict_param">[\s\S]*?<Value\s*\/>[\s\S]*?<\/Dictionary>/.test(dictXml),
			'addParam Dictionary erzeugt leeres <Value/>');
		check(!/<Dictionary Name="neu_dict_param">[\s\S]*?<Value>0<\/Value>/.test(dictXml),
			'addParam Dictionary erzeugt KEIN <Value>0</Value>');
		// Typwechsel zu Dictionary leert den Wert, weg von Dictionary setzt Skalar
		const dSwitch = P.parse(original);
		const someNum = P.getParameters(dSwitch).find((p) => p.valueKind === 'number' && !p.array);
		if (someNum) {
			const sn = P.getParameters(dSwitch).find((p) => p.name === someNum.name);
			P.setType(sn.node, 'Dictionary');
			const after = P.getParameters(P.parse(P.serialize(dSwitch))).find((p) => p.name === someNum.name);
			check(after.type === 'Dictionary' && (after.value == null || after.value === ''),
				'setType→Dictionary leert den Wert');
			const sn2 = P.getParameters(dSwitch).find((p) => p.name === someNum.name);
			P.setType(sn2.node, 'Integer');
			check(/<Integer Name="[^"]*">[\s\S]*?<Value>0<\/Value>/.test(P.serialize(dSwitch)) ||
				P.serialize(dSwitch).includes('>0<'), 'setType Dictionary→Integer setzt Skalar-Default');
		}

		// setValueByType: Komma-Eingabe landet als Punkt im XML
		const numP = P.getParameters(P.parse(original)).find((p) => p.valueKind === 'number' && !p.array);
		if (numP) {
			const d7 = P.parse(original);
			const np = P.getParameters(d7).find((p) => p.name === numP.name);
			P.setValueByType(np.node, 'RealNum', '2,75');
			check(P.serialize(d7).includes('2.75'), 'setValueByType schreibt Komma-Eingabe als Punkt');
		}

		// String-Escaping (Punkt 4)
		check(P.escapeGdlStr('a"b') === 'a""b', 'escapeGdlStr verdoppelt "');
		check(P.unescapeGdlStr('a""b') === 'a"b', 'unescapeGdlStr macht "" rückgängig');
		let threw = false; try { P.escapeGdlStr('x]]>y'); } catch { threw = true; }
		check(threw, 'escapeGdlStr lehnt ]]> ab');
		const strP = P.getParameters(P.parse(original)).find((p) => p.valueKind === 'string' && !p.array);
		if (strP) {
			const d6 = P.parse(original);
			const sp = P.getParameters(d6).find((p) => p.name === strP.name);
			P.setValueByType(sp.node, sp.type, 'sag "hallo" & tschüss');
			const re = P.getParameters(P.parse(P.serialize(d6))).find((p) => p.name === strP.name);
			check(re.valueText === 'sag "hallo" & tschüss', 'String mit Quote: schreiben+lesen symmetrisch');
		}
	}

	console.log('Byte-identisch: reorder ' + reorderOk + '/' + files.length +
		', flag±  ' + flagOk + '/' + files.length);
	console.log('\n────────────────────────────────────────');
	console.log(fails === 0 ? 'ALLE STRUKTUR-CHECKS GRÜN' : (fails + ' CHECK(S) FEHLGESCHLAGEN'));
	process.exit(fails === 0 ? 0 : 1);
}

main();
