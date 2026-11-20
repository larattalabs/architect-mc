package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.GZIPInputStream;
import org.junit.jupiter.api.Test;

/**
 * (RTE4) kit/test/fixtures/rte-compat/corpus.json.gz (kit/tools/rte-compat-fixture.mjs): every districts IR v0.85.0..v0.88.0 planned
 * and grew, as each release wrote it; {@code architect_mc:land} of each round equals what v0.88.0's kit read (kit and mod were held equal
 * there), as kit/test/rte-compat.test.mjs holds the kit's readers to it. A round's effective IR is merged here as revise.mjs
 * mergeEffective does (each revision's parts, lots and roads with their rid; its graph appended).
 */
class DistrictLandCompatTest {
	static final Path CORPUS = Path.of("../kit/test/fixtures/rte-compat/corpus.json.gz");

	private static JsonObject corpus() throws Exception {
		try (InputStream in = new GZIPInputStream(Files.newInputStream(CORPUS))) {
			return JsonParser.parseString(new String(in.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
		}
	}

	private static JsonArray arr(JsonObject o, String k) {
		return o.get(k) instanceof JsonArray a ? a : new JsonArray();
	}

	/** The effective IR after the first {@code k} revisions (revise.mjs mergeEffective's members land reads). */
	static JsonObject effective(JsonObject ir, JsonArray revisions, int k) {
		JsonObject out = ir.deepCopy();
		JsonArray parts = arr(out, "parts"), lots = arr(out, "lots"), roads = arr(out, "roads");
		JsonArray nodes = out.get("graph") instanceof JsonObject g ? arr(g, "nodes") : new JsonArray();
		JsonArray edges = out.get("graph") instanceof JsonObject g2 ? arr(g2, "edges") : new JsonArray();
		JsonArray list = new JsonArray();
		for (int i = 0; i < k; i++) {
			JsonObject rv = revisions.get(i).getAsJsonObject();
			for (String key : List.of("parts", "lots", "roads")) {
				JsonArray into = "parts".equals(key) ? parts : "lots".equals(key) ? lots : roads;
				for (JsonElement e : arr(rv, key)) {
					JsonObject c = e.getAsJsonObject().deepCopy();
					c.addProperty("rid", i + 1);
					into.add(c);
				}
			}
			if (rv.get("graph") instanceof JsonObject g) {
				arr(g, "nodes").forEach(n -> nodes.add(n.deepCopy()));
				arr(g, "edges").forEach(e -> edges.add(e.deepCopy()));
			}
			JsonObject r = new JsonObject();
			r.addProperty("rid", i + 1);
			list.add(r);
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

	/** The kit's record shape: [kind, id, cells, district, revision, rect]. */
	private static JsonElement shape(JsonObject land) {
		if (land == null) {
			return JsonNull.INSTANCE;
		}
		JsonArray out = new JsonArray();
		for (JsonElement e : land.getAsJsonArray("parts")) {
			JsonObject p = e.getAsJsonObject();
			JsonArray row = new JsonArray();
			row.add(p.get("kind"));
			row.add(p.get("id"));
			row.add(p.get("cells"));
			row.add(p.get("district") == null ? JsonNull.INSTANCE : p.get("district"));
			row.add(p.get("revision") == null ? JsonNull.INSTANCE : p.get("revision"));
			row.add(p.get("rect") == null ? JsonNull.INSTANCE : p.get("rect"));
			out.add(row);
		}
		return out;
	}

	@Test
	void everyCorpusRoundsLandIsV088s() throws Exception {
		JsonObject c = corpus();
		List<String> bad = new ArrayList<>();
		int n = 0;
		for (JsonElement ce : c.getAsJsonArray("cases")) {
			JsonObject cs = ce.getAsJsonObject();
			JsonArray revs = arr(cs, "revisions"), expected = cs.getAsJsonArray("expected");
			for (int k = 0; k <= revs.size(); k++) {
				n++;
				JsonObject eff = effective(cs.getAsJsonObject("ir"), revs, k);
				JsonElement got = shape(DistrictLand.of(eff, null, null, k > 0));
				JsonElement want = expected.get(k).getAsJsonObject().get("land");
				if (!got.equals(want)) {
					bad.add(cs.get("key").getAsString() + " round " + k + ": " + got + " != " + want);
				}
			}
		}
		assertTrue(n >= 300, "effective IRs: " + n);
		assertEquals(List.of(), bad);
	}
}
