package dev.larattalabs.architect.batch;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.BlueprintTransform;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 6c slice 0a C6, the offline half of gate item 3 (docs/CONTRACT.md 6c 0a §4, §13): {@code Sites.fitMassingToLot} predicts
 * where a detail of that massing will stand. Both use {@link LotFitting#fit(Blueprint, Anchors.Bounds, String, boolean, Integer,
 * boolean)} (fitToLot's fit, here with fitToLot's default options); this runs it on every kit example massing/detail pair (the
 * committed sidecars {@code kit/massings/<t>_massing/} and {@code kit/examples/<t>/}), on 4 street sides x 3 lot sizes: the
 * detail gets the massing's rotation and an origin within 2 on x and z and equal in y. A detail with a turned front gets
 * another rotation (the kit's conformance makes that an error: kit/test/massing.test.mjs).
 *
 * <p>{@code -Dc6.evidence=<file>} writes the evidence JSON there (gate6c0a's c6.json).
 */
class MassingPredictionTest {
	private static final Path KIT = Path.of("..", "kit");
	private static final List<String> PAIRS = List.of("cabin", "gatehouse", "tavern", "tower");
	private static final List<String> SIDES = List.of("north", "east", "south", "west");
	/** tight: the span is the pair's widest footprint along the street (the clamp binds) and the depth just fits; odd; large. */
	private static final List<String> SIZES = List.of("tight", "odd", "large");

	private static JsonObject json(Path p) throws Exception {
		return JsonParser.parseString(Files.readString(p, StandardCharsets.UTF_8)).getAsJsonObject();
	}

	private static JsonObject detailJson(String t) throws Exception {
		return json(KIT.resolve("examples").resolve(t).resolve(t + ".blueprint.json"));
	}

	private static JsonObject massingJson(String t) throws Exception {
		return json(KIT.resolve("massings").resolve(t + "_massing").resolve(t + "_massing.blueprint.json"));
	}

	private static int setback(Blueprint bp) {
		return bp.approach().enabled() && bp.anchors().containsKey(Blueprint.ENTRANCE) ? bp.approach().length() : 0;
	}

	/** The lot for a pair, side and size, its minimum corner at negative x and z (floorDiv and floor are exercised). */
	private static Anchors.Bounds lot(Blueprint m, Blueprint d, String side, String size) {
		boolean alongX = side.equals("north") || side.equals("south");
		int turnsM = BlueprintTransform.turnsToFace(m.front(), side);
		int turnsD = BlueprintTransform.turnsToFace(d.front(), side);
		int width = 0;
		int depth = 0;
		for (Object[] b : List.of(new Object[] {m, turnsM}, new Object[] {d, turnsD})) {
			Blueprint bp = (Blueprint) b[0];
			int turns = (Integer) b[1];
			int rsx = BlueprintTransform.rotatedSizeX(bp.sizeX(), bp.sizeZ(), turns);
			int rsz = BlueprintTransform.rotatedSizeZ(bp.sizeX(), bp.sizeZ(), turns);
			width = Math.max(width, alongX ? rsx : rsz);
			depth = Math.max(depth, (alongX ? rsz : rsx) + setback(bp));
		}
		int span;
		int deep;
		switch (size) {
			case "tight" -> {
				span = width;
				deep = depth;
			}
			case "odd" -> {
				span = width + 5 + (width % 2 == 0 ? 1 : 0); // an odd span: the centre column is exact
				deep = depth + 3;
			}
			default -> {
				span = 40;
				deep = 41;
			}
		}
		int sx = alongX ? span : deep;
		int sz = alongX ? deep : span;
		int x0 = -37;
		int z0 = -18;
		return new Anchors.Bounds(x0, 63, z0, x0 + sx - 1, 80, z0 + sz - 1);
	}

	@Test
	void detailFitMatchesMassingFit() throws Exception {
		JsonArray cases = new JsonArray();
		int n = 0;
		int maxDx = 0;
		int maxDz = 0;
		int maxDy = 0;
		boolean rotationsEqual = true;
		boolean allFit = true;
		int turned = 0;
		for (String t : PAIRS) {
			Blueprint m = Blueprint.fromJson(massingJson(t));
			Blueprint d = Blueprint.fromJson(detailJson(t));
			assertEquals(t + "_massing", m.id());
			assertEquals(t, d.id());
			for (String side : SIDES) {
				for (String size : SIZES) {
					Anchors.Bounds lot = lot(m, d, side, size);
					LotFitting.Fit fm = LotFitting.fit(m, lot, side, false, null, false);
					LotFitting.Fit fd = LotFitting.fit(d, lot, side, false, null, false);
					String what = t + " " + side + " " + size;
					assertTrue(fm.fits(), what + ": the massing fits (" + fm.why() + ")");
					assertTrue(fd.fits(), what + ": the detail fits (" + fd.why() + ")");
					assertEquals(fm.turns(), fd.turns(), what + ": the same rotation");
					int dx = fd.ox() - fm.ox();
					int dy = fd.oy() - fm.oy();
					int dz = fd.oz() - fm.oz();
					assertTrue(Math.abs(dx) <= 2 && Math.abs(dz) <= 2, what + ": origin within 2 on x and z, off by " + dx + ", " + dz);
					assertEquals(0, dy, what + ": origin equal in y");
					maxDx = Math.max(maxDx, Math.abs(dx));
					maxDz = Math.max(maxDz, Math.abs(dz));
					maxDy = Math.max(maxDy, Math.abs(dy));
					rotationsEqual &= fm.turns() == fd.turns();
					allFit &= fm.fits() && fd.fits();
					JsonObject c = new JsonObject();
					c.addProperty("pair", t);
					c.addProperty("side", side);
					c.addProperty("size", size);
					c.addProperty("lot", lot.minX() + "," + lot.minY() + "," + lot.minZ() + " .. " + lot.maxX() + "," + lot.maxY() + "," + lot.maxZ());
					c.addProperty("turns", fm.turns());
					c.addProperty("massingOrigin", fm.ox() + "," + fm.oy() + "," + fm.oz());
					c.addProperty("detailOrigin", fd.ox() + "," + fd.oy() + "," + fd.oz());
					c.addProperty("dx", dx);
					c.addProperty("dy", dy);
					c.addProperty("dz", dz);
					cases.add(c);
					n++;
				}
			}
			// a detail with a turned front stands turned (the kit's conformance refuses it, so the prediction holds)
			for (String f : List.of("north", "east", "west")) {
				JsonObject dj = detailJson(t);
				dj.addProperty("front", f);
				Blueprint turnedDetail = Blueprint.fromJson(dj);
				Anchors.Bounds lot = lot(m, d, "south", "large");
				assertNotEquals(LotFitting.fit(m, lot, "south", false, null, false).turns(), LotFitting.fit(turnedDetail, lot, "south", false, null, false).turns(),
					t + " turned " + f);
				turned++;
			}
		}
		assertEquals(PAIRS.size() * SIDES.size() * SIZES.size(), n);
		String out = System.getProperty("c6.evidence", "");
		if (!out.isBlank()) {
			JsonObject e = new JsonObject();
			e.addProperty("item", "C6 massing placement prediction (offline half of gate6c0a item 3)");
			e.addProperty("test", "mod/src/test/java/dev/larattalabs/architect/batch/MassingPredictionTest.java");
			e.addProperty("fit", "LotFitting.fit(bp, lot, side, centreOnBox=false, setback=null, intoStreet=false), as Sites.fitToLot / fitMassingToLot");
			JsonArray pairs = new JsonArray();
			PAIRS.forEach(p -> pairs.add(p + "_massing / " + p));
			e.add("pairs", pairs);
			JsonArray sides = new JsonArray();
			SIDES.forEach(sides::add);
			e.add("sides", sides);
			JsonArray sizes = new JsonArray();
			SIZES.forEach(sizes::add);
			e.add("sizes", sizes);
			e.addProperty("cases", n);
			e.addProperty("allFit", allFit);
			e.addProperty("rotationEqual", rotationsEqual);
			e.addProperty("maxAbsDx", maxDx);
			e.addProperty("maxAbsDz", maxDz);
			e.addProperty("maxAbsDy", maxDy);
			e.addProperty("bound", "|dx|,|dz| <= 2, dy == 0");
			e.addProperty("turnedFrontCases", turned);
			e.addProperty("turnedFrontRotationDiffers", true);
			e.addProperty("turnedFrontConformance", "error (kit/test/massing.test.mjs: 'a turned front is an error')");
			e.addProperty("pass", true);
			e.add("detail", cases);
			Gson g = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
			Path p = Path.of(out);
			if (p.getParent() != null) {
				Files.createDirectories(p.getParent());
			}
			Files.writeString(p, g.toJson(e) + "\n", StandardCharsets.UTF_8);
		}
	}
}
