package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.CheckReport;
import dev.larattalabs.architect.api.PreviewView;
import dev.larattalabs.architect.api.RegionPreviews;
import dev.larattalabs.architect.region.volume.Arvx;
import dev.larattalabs.architect.region.volume.Arwd;
import java.nio.file.Path;
import java.util.List;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/** Phase 6b wire shapes: report.json, previews, the ghost's plan view, command params, ARWD. */
class Wire6bTest {
	static final String REPORT = """
		{"format": 1, "irSha": "x", "mode": "virtual", "ok": false, "errors": 1, "warnings": 2,
		 "findings": [
		   {"rule": "M1", "severity": "error", "part": "bowl", "stage": "ground", "count": 3, "sample": [[1, 2, 3], [4, 5, 6]], "message": "outside"},
		   {"rule": "M3:floating_spur", "severity": "warning", "part": null, "stage": null, "count": 1, "sample": [], "message": "spur"},
		   {"rule": "M8", "severity": "warning", "part": "rim", "count": 40, "message": "unguarded"}],
		 "metrics": {"M2": {"nodes": 4, "reached": 4}}}
		""";

	@Test
	void report() {
		CheckReport r = Wire6b.report(JsonParser.parseString(REPORT));
		assertFalse(r.ok());
		assertEquals(1, r.errors());
		assertEquals(2, r.warnings());
		assertEquals(3, r.findings().size());
		CheckReport.Finding f = r.findings().get(0);
		assertTrue(f.error());
		assertEquals("bowl", f.part());
		assertEquals(List.of(new BlockPos(1, 2, 3), new BlockPos(4, 5, 6)), f.sample());
		assertNull(r.findings().get(1).part());
		assertEquals(1, r.of("M3").size(), "M3 includes its sub-rules");
		assertEquals("NOT ok: 1 error, 2 warnings (M1 x1, M3:floating_spur x1, M8 x1)", Wire6b.summary(r));
		assertEquals(r, Wire6b.report(Wire6b.json(r)), "round trip");
		assertNull(Wire6b.report(null));
	}

	@Test
	void previews() {
		JsonObject paths = JsonParser.parseString("{\"top\": [\"/p/top.png\"], \"section\": [\"/p/section-0.png\", \"/p/section-1.png\"], \"iso\": "
			+ "\"/p/iso.png\", \"siteplan\": [\"/p/siteplan.svg\", \"/p/siteplan.png\"], \"other\": []}").getAsJsonObject();
		RegionPreviews p = Wire6b.previews(paths, JsonParser.parseString("{\"format\": 1, \"lots\": []}"));
		assertEquals(List.of(Path.of("/p/section-0.png"), Path.of("/p/section-1.png")), p.images().get(PreviewView.SECTION));
		assertEquals(List.of(Path.of("/p/iso.png")), p.images().get(PreviewView.ISO));
		assertEquals(4, p.images().size());
		assertEquals(1, p.sitePlan().get("format").getAsInt());
		assertEquals(0, Wire6b.previews(paths, JsonParser.parseString("\"/no/such/siteplan.json\"")).sitePlan().size());
		assertNull(Wire6b.previews(null, null));
	}

	@Test
	void ghostPlan() {
		JsonObject ir = JsonParser.parseString("""
			{"format": 2, "id": "sky", "kitVersion": "0.12.0", "seed": "1",
			 "claim": {"minX": 0, "minZ": 0, "maxX": 127, "maxZ": 127, "minY": 0, "maxY": 255},
			 "stages": ["ground", "islands", "lots-1"],
			 "tiles": {"ground": {"terrain": ["0,0"], "path": []}, "islands": {"terrain": ["1,0", "1,1"], "path": ["0,1"]}, "lots-1": {"terrain": [], "path": []}},
			 "lots": [{"id": "l1", "stage": "lots-1", "part": "pad", "floorY": 160, "front": "south", "max": [9, 12, 9],
			           "box": {"minX": 70, "minY": 160, "minZ": 10, "maxX": 78, "maxY": 171, "maxZ": 18}}],
			 "floating": [{"parts": ["isle"], "anchor": null}],
			 "parts": [{"id": "isle", "stage": "islands", "set": "terrain", "ops": [{"op": "shape", "bounds": {"minX": 64, "maxX": 127, "minZ": 0, "maxZ": 63, "minY": 140, "maxY": 170}}]}],
			 "anchors": {"entrance": [5, 70, 5], "spawn": [6, 70, 6]}, "budget": {"cells": 900, "removed": 100, "added": 800}}
			""").getAsJsonObject();
		GhostPlan g = GhostPlan.of("p1", "sha", Ir.of(ir), "islands", null);
		assertEquals(List.of("0,0", "1,0", "1,1", "0,1"), g.tiles(), "stages up to islands, both sets");
		assertEquals(List.of("0,0"), g.tilesNear(10, 10, 20));
		assertEquals(4, g.tilesNear(64, 64, 64).size());
		assertEquals(70, g.groundY());
		assertEquals(1, g.kind(5, 70, 5, true, false), "air: removed");
		assertEquals(3, g.kind(72, 159, 12, false, false), "the lot box from the pad's top row");
		assertEquals(4, g.kind(100, 150, 30, false, true), "inside a floating part's op bounds");
		assertEquals(2, g.kind(5, 70, 5, false, true), "walk: path");
		assertEquals(0, g.kind(5, 70, 5, false, false));
		assertTrue(g.verdict().startsWith("checker not checked · budget 900 cells (800 added, 100 removed)"), g.verdict());
		assertEquals(4, GhostPlan.of("p1", "sha", Ir.of(ir), null, null).tiles().size());
	}

	@Test
	void commandParams() {
		boolean[] check = {true};
		JsonObject p = RegionCommands.params("radius=80 depth=24 name=crater wet=true scale=0.5 nocheck", check);
		assertEquals(80, p.get("radius").getAsInt());
		assertEquals("crater", p.get("name").getAsString());
		assertTrue(p.get("wet").getAsBoolean());
		assertEquals(0.5, p.get("scale").getAsDouble());
		assertFalse(check[0]);
		assertEquals(12, RegionCommands.params("{\"lots\": 12}", check).get("lots").getAsInt());
		assertTrue(check[0]);
		assertThrows(IllegalArgumentException.class, () -> RegionCommands.params("radius", check));
	}

	@Test
	void arwd() {
		int[] box = {0, 0, 0, 1, 2, 0};
		byte[] raw = Arwd.encode(box, List.of("minecraft:air", "minecraft:stone"), new int[] {1, 1, 0, 1, 0, 0}, new byte[] {0, 0, 15, 0, 7, 7});
		assertEquals('A', raw[0]);
		assertEquals('W', raw[2]);
		assertEquals(1, raw[5], "flags: light present");
		// header 8 + box 24, palette: 1 + (1+13) + (1+15)
		int at = 8 + 24 + 1 + 14 + 16;
		assertEquals(List.of(1, 2, 0, 1, 1, 1, 0, 2), ints(raw, at, 8), "column 0: stone x2, air x1; column 1: stone, air x2");
		assertEquals(12, Arvx.sha256(raw).length() / 64 * 12);
	}

	static List<Integer> ints(byte[] a, int from, int n) {
		List<Integer> out = new java.util.ArrayList<>();
		for (int i = 0; i < n; i++) {
			out.add((int) a[from + i]);
		}
		return out;
	}
}
