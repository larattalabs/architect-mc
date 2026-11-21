package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;
import org.junit.jupiter.api.Test;

/**
 * (RTE5) kit/test/fixtures/rte-compat/rte5.json.gz (kit/tools/rte5-compat-fixture.mjs): the shapes RTE4's corpus lacked (plan_v0 zones,
 * bandless growth, ridge and biome-edge boundaries, seam, reach and gate joins beside a town, undo and gapped histories, histories across
 * releases) and RTE4's cases under v0.48.0..v0.84.0, each IR as its release wrote it. {@code architect_mc:land} of each round equals what
 * v0.88.0's kit read, by exact cell runs (each part's, the union's, outside's and inside's), the town's claim given for a case beside one.
 * A round's effective IR is merged as revise.mjs mergeEffective does: its revisions (by rid) in position order, each one's parts, lots
 * and roads with that rid, its graph appended.
 */
class DistrictLandCompat5Test {
	static final Path CORPUS = Path.of("../kit/test/fixtures/rte-compat/rte5.json.gz");

	private static JsonObject corpus() throws Exception {
		try (InputStream in = new GZIPInputStream(Files.newInputStream(CORPUS))) {
			return JsonParser.parseString(new String(in.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
		}
	}

	private static JsonArray arr(JsonObject o, String k) {
		return o.get(k) instanceof JsonArray a ? a : new JsonArray();
	}

	/** The effective IR of a round: {@code revs} (rids) from {@code revisions} ([{rid, position, ir}]), merged by position. */
	static JsonObject effective(JsonObject ir, JsonArray revisions, JsonArray revs) {
		Map<Integer, JsonObject> byRid = new HashMap<>();
		for (JsonElement e : revisions) {
			byRid.put(e.getAsJsonObject().get("rid").getAsInt(), e.getAsJsonObject());
		}
		List<JsonObject> chosen = new ArrayList<>();
		revs.forEach(r -> chosen.add(byRid.get(r.getAsInt())));
		chosen.sort(Comparator.comparingInt(r -> r.get("position").getAsInt()));
		JsonObject out = ir.deepCopy();
		JsonArray parts = arr(out, "parts"), lots = arr(out, "lots"), roads = arr(out, "roads");
		JsonArray nodes = out.get("graph") instanceof JsonObject g ? arr(g, "nodes") : new JsonArray();
		JsonArray edges = out.get("graph") instanceof JsonObject g2 ? arr(g2, "edges") : new JsonArray();
		JsonArray list = new JsonArray();
		for (JsonObject r : chosen) {
			int rid = r.get("rid").getAsInt();
			JsonObject rv = r.getAsJsonObject("ir");
			for (String key : List.of("parts", "lots", "roads")) {
				JsonArray into = "parts".equals(key) ? parts : "lots".equals(key) ? lots : roads;
				for (JsonElement e : arr(rv, key)) {
					JsonObject c = e.getAsJsonObject().deepCopy();
					c.addProperty("rid", rid);
					into.add(c);
				}
			}
			if (rv.get("graph") instanceof JsonObject g) {
				arr(g, "nodes").forEach(n -> nodes.add(n.deepCopy()));
				arr(g, "edges").forEach(e -> edges.add(e.deepCopy()));
			}
			JsonObject x = new JsonObject();
			x.addProperty("rid", rid);
			list.add(x);
		}
		out.add("parts", parts);
		out.add("lots", lots);
		out.add("roads", roads);
		if (!nodes.isEmpty() || !edges.isEmpty()) {
			JsonObject g = new JsonObject();
			g.add("nodes", nodes);
			g.add("edges", edges);
			out.add("graph", g);
		}
		out.add("revisions", list);
		return out;
	}

	private static JsonElement orNull(JsonElement e) {
		return e == null ? JsonNull.INSTANCE : e;
	}

	/** A cell set's record as the kit's reader writes it: [cells, runs as JSON text, rect]. */
	private static JsonElement rec(JsonObject r) {
		JsonArray row = new JsonArray();
		row.add(r.get("cells"));
		row.add(new JsonPrimitive(r.get("runs").toString()));
		row.add(orNull(r.get("rect")));
		return row;
	}

	/** The kit reader's shape: {v, union, outside, inside, parts: [[kind, id, cells, district, revision, rect, runs as JSON text]]}. */
	private static JsonElement shape(JsonObject land) {
		if (land == null) {
			return JsonNull.INSTANCE;
		}
		JsonObject out = new JsonObject();
		out.add("v", land.get("v"));
		out.add("union", rec(land.getAsJsonObject("union")));
		out.add("outside", rec(land.getAsJsonObject("outside")));
		out.add("inside", rec(land.getAsJsonObject("inside")));
		JsonArray parts = new JsonArray();
		for (JsonElement e : land.getAsJsonArray("parts")) {
			JsonObject p = e.getAsJsonObject();
			JsonArray row = new JsonArray();
			row.add(p.get("kind"));
			row.add(p.get("id"));
			row.add(p.get("cells"));
			row.add(orNull(p.get("district")));
			row.add(orNull(p.get("revision")));
			row.add(orNull(p.get("rect")));
			row.add(new JsonPrimitive(p.get("runs").toString()));
			parts.add(row);
		}
		out.add("parts", parts);
		return out;
	}

	@Test
	void everyRoundsLandIsV088sByExactRuns() throws Exception {
		JsonObject c = corpus();
		List<String> bad = new ArrayList<>();
		int n = 0;
		for (JsonElement ce : c.getAsJsonArray("cases")) {
			JsonObject cs = ce.getAsJsonObject();
			JsonArray rounds = cs.getAsJsonArray("rounds"), expected = cs.getAsJsonArray("expected");
			int[] town = null;
			if (cs.get("standingClaim") instanceof JsonArray t) {
				town = new int[] {t.get(0).getAsInt(), t.get(1).getAsInt(), t.get(2).getAsInt(), t.get(3).getAsInt()};
			}
			for (int k = 0; k < rounds.size(); k++) {
				n++;
				JsonObject rd = rounds.get(k).getAsJsonObject();
				JsonObject eff = effective(cs.getAsJsonObject("ir"), arr(cs, "revisions"), rd.getAsJsonArray("revs"));
				JsonElement got = shape(DistrictLand.of(eff, town, null, rd.get("revised").getAsBoolean()));
				JsonElement want = expected.get(k).getAsJsonObject().get("land");
				if (!got.equals(want)) {
					bad.add(cs.get("key").getAsString() + " round " + k + ": " + got.toString().substring(0, Math.min(400, got.toString().length())));
				}
			}
		}
		assertTrue(n >= 1200, "effective IRs: " + n);
		assertEquals(List.of(), bad);
	}
}
