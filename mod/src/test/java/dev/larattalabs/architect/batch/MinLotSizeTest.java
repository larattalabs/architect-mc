package dev.larattalabs.architect.batch;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * 6c slice 0c §2 and gate item 1 (unit): for every kit example design and massing, every street side and three setback rules,
 * a lot of exactly {@code minLotSize} fits, one block less on either axis is LOT_TOO_SMALL, {@code fitToLot(recommendedLot)}
 * gives the same origin and rotation, and a too-small lot's recommendedLot fits.
 */
class MinLotSizeTest {
	private static final List<String> SIDES = List.of("north", "east", "south", "west");

	private static List<Blueprint> kitBlueprints() throws IOException {
		List<Blueprint> out = new ArrayList<>();
		for (String dir : List.of("../kit/examples", "../kit/massings")) {
			Path d = Path.of(dir);
			if (!Files.isDirectory(d)) {
				continue;
			}
			try (Stream<Path> s = Files.walk(d)) {
				for (Path p : s.filter(f -> f.getFileName().toString().endsWith(".blueprint.json")).sorted().toList()) {
					out.add(Blueprint.fromJson(JsonParser.parseString(Files.readString(p)).getAsJsonObject()));
				}
			}
		}
		return out;
	}

	/** A lot {@code along × deep} with its street edge on {@code side}, near (1000, 64, -500). */
	private static Anchors.Bounds lot(String side, int along, int deep) {
		int x0 = 1000;
		int z0 = -500;
		boolean alongX = side.equals("north") || side.equals("south");
		return alongX ? new Anchors.Bounds(x0, 64, z0, x0 + along - 1, 80, z0 + deep - 1) : new Anchors.Bounds(x0, 64, z0, x0 + deep - 1, 80, z0 + along - 1);
	}

	@Test
	void everyKitDesignAndMassingOnEverySide() throws IOException {
		List<Blueprint> bps = kitBlueprints();
		assertEquals(8, bps.size(), "4 example designs and 4 massings in the kit");
		int checked = 0;
		for (Blueprint bp : bps) {
			for (String side : SIDES) {
				for (Object[] rule : new Object[][] {{null, false}, {2, false}, {null, true}}) {
					Integer setback = (Integer) rule[0];
					boolean into = (Boolean) rule[1];
					int[] m = LotFitting.minSize(bp, setback, into);
					String what = bp.id() + " " + side + " setback " + setback + (into ? " intoStreet" : "");
					LotFitting.Fit exact = LotFitting.fit(bp, lot(side, m[0], m[1]), side, false, setback, into);
					assertTrue(exact.fits(), what + ": the minimal lot fits (" + exact.why() + ")");
					assertEquals(m[2], exact.setback(), what);
					assertFalse(LotFitting.fit(bp, lot(side, m[0] - 1, m[1]), side, false, setback, into).fits(), what + ": one less along the street");
					assertFalse(LotFitting.fit(bp, lot(side, m[0], m[1] - 1), side, false, setback, into).fits(), what + ": one less deep");
					// the recommended lot of a roomy lot reproduces the fit
					Anchors.Bounds big = lot(side, m[0] + 9, m[1] + 7);
					for (boolean box : new boolean[] {false, true}) {
						LotFitting.Fit f = LotFitting.fit(bp, big, side, box, setback, into);
						assertTrue(f.fits(), what);
						Anchors.Bounds rec = LotFitting.recommended(f, big, side);
						LotFitting.Fit again = LotFitting.fit(bp, rec, side, box, setback, into);
						assertTrue(again.fits(), what + ": its recommended lot fits");
						assertEquals(f.box(), again.box(), what + ": the same origin on the recommended lot");
						assertEquals(f.turns(), again.turns(), what + ": the same rotation");
						assertEquals(big.minY(), rec.minY(), what);
						assertEquals(big.maxY(), rec.maxY(), what);
					}
					// a too-small lot's recommended lot fits (and is the one it needs)
					Anchors.Bounds small = lot(side, Math.max(1, m[0] - 3), Math.max(1, m[1] - 2));
					LotFitting.Fit tooSmall = LotFitting.fit(bp, small, side, false, setback, into);
					assertFalse(tooSmall.fits(), what);
					Anchors.Bounds rec = LotFitting.recommended(tooSmall, small, side);
					LotFitting.Fit onRec = LotFitting.fit(bp, rec, side, false, setback, into);
					assertTrue(onRec.fits(), what + ": a too-small lot's recommended lot fits");
					assertEquals(tooSmall.box(), onRec.box(), what + ": the same origin as the too-small fit");
					checked++;
				}
			}
		}
		assertEquals(8 * 4 * 3, checked);
	}
}
