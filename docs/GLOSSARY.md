# Glossary

The words Architect's screens use (PR G1). The player reads them in a screen's "?" overlay (Terms), on the Status tab's
Help page and in each screen's "what's this" line. The source of truth is `ArchitectGlossary.java`; this page mirrors it.

**Wording rule (UI-2b):** say *design*, never *blueprint*. `GlossaryWordingTest` checks Architect's lang file and the
sentence-like string literals of its client and command code (lab-ui `WordingLint`). Internal names (`blueprintId`,
`<entry>.blueprint.json`, DevBridge hook fields) are not player text and are not checked.

## Architect

| Term | Meaning |
|---|---|
| design | A building Architect can place: its blocks, size and type. Your designs are in the Library. |
| Style | A set of materials and shape hints a design wears. The same design in another Style is a variant. |
| parts | Pieces a Style can add to a design, such as a porch, a chimney or a tower. |
| variant | A copy of a design in other materials or another Style, made by the design helper. |
| set | Several designs made together to match, such as a farm's house, barn and silo. |
| collection | A group of designs you keep together in the Library. |
| site | A design placed in this world. Library > Placed lists them; you can move or remove one. |
| construction site | In survival, a site that builds itself as you feed its crate. |
| build | To place a design: at once in creative, as a construction site in survival. |
| crate | The chest at a construction site. What you put in it is used to build. |
| stockpile | The materials a construction site holds, ready to build with. |
| design helper | The program that runs Claude to design buildings. Placing and the Library work without it. |
| ghost | The see-through preview of a design before you place it. Its outline says whether it fits. |
| plot | An area you mark on the ground for a design or a link. Not the same as a Steward lot. |
| region | A larger area laid out at once: several sites, with paths, lots and links between them. |
| lot | One building's place inside a region or a settlement (Steward uses the same word). |
| connector or link | A path, bridge, stair or tunnel joining two places. The Build a link key starts one. |

## Shared with Steward

lab-ui's `Glossary` holds one section per mod and reserves Steward's slot (S-PR-3) with the words it is to define:
settlement, steward, Founding Stone, lot, district, quarter, module, stockpile, bill limit, proposal. The slot stays hidden until
Steward registers its section. *Lot* means the same in both mods. Architect's *plot* (an area you mark) is not a Steward lot.
*Crate* and *stockpile* keep UI-2b's meanings in both. Steward joins the wording test by adding its `Root`
(`-Dwording.steward=true`), or by running `WordingLint` in its own tests.
