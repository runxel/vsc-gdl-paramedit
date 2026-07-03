# GDL Parameter Editor

VSCode-Extension: visueller Editor für GDL-Parameterlisten (`paramlist.xml` /
`Parameters.xml` im HSF-/LP_XMLConverter-Format), wie sie beim Dekompilieren mit
dem LP_XMLConverter erzeugt werden. Der Editor schreibt die XML-Parameterliste
nach Änderungen format-erhaltend neu.

## Sicherheit (round-trip-garantiert)

Der XML-Kern ist **verlustfrei**: Unveränderte Dateien bleiben beim Speichern
**byte-identisch** (BOM, Tabs, CDATA, Attribut-Reihenfolge, Header). Eine
Wertänderung fasst nur genau diese Stelle an. Die Rückkonvertierung zu GSM kann
durch den Editor nicht beschädigt werden.

## Install

See [Releases](https://github.com/gdl-joe/vscode-gdl-parameter-editor/releases/latest)).

In VSCode: Extensions → `…` → **„Aus VSIX installieren…"** → die `.vsix` wählen →
Fenster neu laden.

## Ausprobieren (aus dem Quellcode)

1. Diesen Ordner in VSCode öffnen.
2. **F5** → „Extension starten (Development Host)“.
3. Im neuen Fenster eine `…‚/<Objekt>/<Objekt>/paramlist.xml` öffnen.
4. Es öffnet sich der visuelle Editor. Über das Editor-Menü
   („Reopen Editor With… → Text Editor“) lässt sich jederzeit der Rohtext zeigen.

## Funktionsumfang

- **Parameterliste** mit Typ-Auswahl, Name, Beschreibung und Wert; Live-Filter
  über Name/Beschreibung.
- **Editieren** typabhängig: Boolean = Checkbox, String = CDATA-/Quote-sicher,
  Zahlen/Indizes als Textfeld; Beschreibungen und Namen direkt editierbar.
- **Typ ändern** per Dropdown (Wertformat wird angepasst).
- **Flags umschalten** per Klick: `Hidden`, `Bold`, `Unique`, `Child`.
- **Fixe Parameter** (`Fix` vom Subtype vorgegeben) werden als **blaue Zeile**
  angezeigt — wie im Archicad-Editor — und sind bewusst nicht umschaltbar.
- **Eindeutige Namen** werden erzwungen (case-insensitiv) inkl. Namensvalidierung.
- **Hinzufügen / Löschen / Verschieben**: neuer Parameter an beliebiger Stelle
  (＋ pro Zeile), Löschen (rückgängig mit Cmd+Z), Reihenfolge per ▲▼ **oder
  Drag & Drop** (Griff ⠿).
- **Title-Gruppen**: Gruppen-Überschriften anlegen (+ Gruppe) und Parameter per
  `Child`-Flag darunter einrücken.
- **Array-Editor** (1D & 2D): Zellen editieren, Zeilen/Spalten hinzufügen/entfernen,
  zwischen skalar und Array wandeln; sparse Arrays bleiben erhalten.
- **b-prisma-Logo** themenabhängig (hell/dunkel) in der Toolbar.

## Aufbau

- `extension.js` — registriert den `CustomTextEditor`, Webview-Bridge (postMessage),
  schreibt Änderungen round-trip-sicher via WorkspaceEdit zurück.
- `src/paramlist.js` — verlustfreier Parser/Serializer + typisierte Lese-/Editier-Schicht.
- `media/editor.js` / `media/editor.css` — Webview-Frontend (VSCode-Theming).
- `test/` — round-trip- und Mutations-Tests.
