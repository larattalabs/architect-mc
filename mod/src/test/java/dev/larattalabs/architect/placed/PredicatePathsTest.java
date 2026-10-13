package dev.larattalabs.architect.placed;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * 6c PT §7 "One predicate": every write path consults {@code Placed.build} (directly, or through {@code BuildViews.scan} or the
 * terrain flag it sets); this test lists the paths and fails when one stops calling it. And every Architect block write in site/,
 * region/ and placement/ goes through {@code Placed.set} (or a template placement under {@code Placed.beginWrites}), so it clears
 * (or, in an undo, restores) the record: a raw {@code level.setBlock} there is only allowed for the listed shape and leaf updates,
 * which keep a cell's record as vanilla's in-place changes do.
 */
class PredicatePathsTest {
	static final Path SRC = Path.of("src/main/java/dev/larattalabs/architect");

	/** Path -> the files that implement it and must call the predicate. */
	static final Map<String, List<String>> PATHS = Map.ofEntries(
		Map.entry("TileCheck stage 0, felling, leaves, dependents and supports (regions, strokes)", List.of("site/TileCheck.java")),
		Map.entry("Sites place/check, batch building and move (the snapshot box)", List.of("site/Sites.java", "placed/BuildViews.java")),
		Map.entry("Approaches (TerrainFit.BUILD)", List.of("site/Sites.java", "placement/Approach.java")),
		Map.entry("placeRoad / checkRoad (PATH builds joined)", List.of("site/roads/Roads.java", "site/roads/RoadTerrain.java")),
		Map.entry("placeCells / checkCells", List.of("site/InfraPlace.java", "site/CellsCheck.java")),
		Map.entry("applyDelta / checkDelta", List.of("site/SiteDeltas.java", "site/DeltaJob.java")),
		Map.entry("fitToLot (the recommended rect)", List.of("apiimpl/SitesImpl.java")),
		Map.entry("Region plan keep-outs", List.of("region/RegionsImpl.java")),
		Map.entry("Brush strokes (consent, PLAYER_BLOCKS)", List.of("region/Brushes.java", "site/RegionItems.java")));

	static String read(String rel) throws IOException {
		return Files.readString(SRC.resolve(rel));
	}

	@Test
	void everyPathConsultsThePredicate() throws IOException {
		List<String> missing = new ArrayList<>();
		for (var e : PATHS.entrySet()) {
			boolean any = false;
			for (String f : e.getValue()) {
				String s = read(f);
				any |= s.contains("Placed.build(") || s.contains("BuildViews.scan(") || s.contains("TerrainFit.BUILD") || s.contains("Placed.Consent")
					|| s.contains("BuildViews.keepOut(") || s.contains("Placed.naturalForWrites(") || s.contains("SiteDeltas.buildRefusal(")
					|| s.contains("rec.consented") || s.contains("BuildViews.consent(");
			}
			if (!any) {
				missing.add(e.getKey() + " " + e.getValue());
			}
		}
		assertEquals(List.of(), missing);
		assertTrue(read("placed/Placed.java").contains("public static @Nullable String build(Level level, @Nullable LevelChunk chunk, int x, int y, int z)"));
	}

	/** Raw writes that stay raw: shape updates of the template writer and the leaf guard's persistence (in-place changes). */
	static final List<String> RAW_OK = List.of("site/TemplateWriter.java:edgeA", "site/TemplateWriter.java:edgeB", "site/TemplateWriter.java:newState",
		"site/InfraJob.java:leafAfter", "placement/LeafGuard.java:");

	@Test
	void architectWritesGoThroughPlacedSet() throws IOException {
		List<String> raw = new ArrayList<>();
		for (String dir : List.of("site", "region", "placement", "batch")) {
			try (Stream<Path> files = Files.walk(SRC.resolve(dir))) {
				for (Path f : files.filter(p -> p.toString().endsWith(".java")).toList()) {
					String rel = SRC.relativize(f).toString();
					List<String> lines = Files.readAllLines(f);
					for (int i = 0; i < lines.size(); i++) {
						String l = lines.get(i);
						if (!l.contains("level.setBlock(") || l.trim().startsWith("*") || l.trim().startsWith("//")) {
							continue;
						}
						boolean ok = false;
						for (String a : RAW_OK) {
							String[] p = a.split(":", 2);
							ok |= rel.equals(p[0]) && l.contains(p[1]);
						}
						if (!ok) {
							raw.add(rel + ":" + (i + 1) + " " + l.trim());
						}
					}
				}
			}
		}
		assertEquals(List.of(), raw, "Architect writes go through Placed.set");
		String sites = read("site/Sites.java");
		assertTrue(sites.contains("Placed.beginWrites"), "template placements run under Placed.beginWrites");
	}
}
