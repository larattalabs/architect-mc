package dev.larattalabs.architect.client.help;

import dev.larattalabs.labui.ui.Glossary;
import dev.larattalabs.labui.ui.Glossary.Term;
import java.util.List;

/**
 * (PR G1) Architect's glossary section (docs/GLOSSARY.md, UI-2b's wording rule: "design", never "blueprint"). Pure: the terms are
 * plain strings, registered with lab-ui's shared {@link Glossary} at client init and read by the "?" overlay's Terms page, the
 * Status tab's Help page and each screen's "what's this" line.
 */
public final class ArchitectGlossary {
	public static final String OWNER = "architect_mc";
	public static final List<Term> TERMS = List.of(
		new Term("design", "A building Architect can place: its blocks, size and type. Your designs are in the Library."),
		new Term("Style", "A set of materials and shape hints a design wears. The same design in another Style is a variant."),
		new Term("parts", "Pieces a Style can add to a design, such as a porch, a chimney or a tower."),
		new Term("variant", "A copy of a design in other materials or another Style, made by the design helper."),
		new Term("set", "Several designs made together to match, such as a farm's house, barn and silo."),
		new Term("collection", "A group of designs you keep together in the Library."),
		new Term("site", "A design placed in this world. Library > Placed lists them; you can move or remove one."),
		new Term("construction site", "In survival, a site that builds itself as you feed its crate."),
		new Term("build", "To place a design: at once in creative, as a construction site in survival."),
		new Term("crate", "The chest at a construction site. What you put in it is used to build."),
		new Term("stockpile", "The materials a construction site holds, ready to build with."),
		new Term("design helper", "The program that runs Claude to design buildings. Placing and the Library work without it."),
		new Term("ghost", "The see-through preview of a design before you place it. Its outline says whether it fits."),
		new Term("plot", "An area you mark on the ground for a design or a link. Not the same as a Steward lot."),
		new Term("region", "A larger area laid out at once: several sites, with paths, lots and links between them."),
		new Term("lot", "One building's place inside a region or a settlement (Steward uses the same word)."),
		new Term("connector or link", "A path, bridge, stair or tunnel joining two places. The Build a link key starts one."));

	private ArchitectGlossary() {
	}

	public static Glossary.Section section() {
		return new Glossary.Section(OWNER, "Architect", TERMS);
	}

	public static void register() {
		Glossary.register(section());
	}
}
