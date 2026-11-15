# 7c BR library fixtures

`library/gen_pa_treehouse_home/` and `library/gen_pa_treehouse_lodge/` are two cached library entries from 7b's paid batch (P2, the
treehouse village, its `standalone-off` library; designed by the claude login and paid for then). They are committed here so that a gate in a
fresh run dir has them; the preview PNGs are left out.

BR's S5 brief run (`tools/scenarios.mjs run s5 --brief`) copies them into the game's library before the world opens. Each `wrap_trunk` site lot
then gets a $0 `Designs.siteVariant` of one of them: the entry's own source re-runs on the new site, in its own roles. There is no design
call and no spend. Lots of any other fit use SB's sim archetype. The source is unchanged from 7b (no edits, no absolute paths, no personal data).
