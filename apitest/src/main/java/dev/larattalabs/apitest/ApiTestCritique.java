package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.BibleRequest;
import dev.larattalabs.architect.api.Critique;
import dev.larattalabs.architect.api.CritiqueMode;
import dev.larattalabs.architect.api.CritiqueSpec;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.JobSpec;
import dev.larattalabs.architect.api.SiteEvents;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.Deflater;
import net.minecraft.commands.CommandSourceStack;

/**
 * The phase 5a steps of apitest (docs/CONTRACT.md "Phase 5a contract", "Java API (1.6.0)"): designs and groups with a critique
 * spec, a design's {@link Critique} and DESIGN_CRITIQUED, a report critique of a library entry and the entry's critique, the
 * estimate's critique figures, bible archive and delete (with the pin and owner refusals) and restraint, and a structured job
 * with images, through {@code dev.larattalabs.architect.api} only. Structured arguments come as base64 JSON. Results go under keys
 * for {@code /apitest get <key>}.
 */
public final class ApiTestCritique {
	private ApiTestCritique() {
	}

	static void init() {
		SiteEvents.DESIGN_CRITIQUED.register((id, r) -> {
			JsonObject o = round(r);
			o.addProperty("id", id);
			ApiTest.event("DESIGN_CRITIQUED", o);
		});
	}

	private static JsonObject b64(String s) {
		return JsonParser.parseString(new String(Base64.getDecoder().decode(s), StandardCharsets.UTF_8)).getAsJsonObject();
	}

	/** A spec from {mode, maxRevisions?, budgetUsd?, maxMinutes?, shipScore?, views?, extraCriteria?, model?, effort?, neighbours?}. */
	static CritiqueSpec spec(JsonObject o) {
		CritiqueSpec.Builder b = CritiqueSpec.builder(CritiqueMode.of(o.has("mode") ? o.get("mode").getAsString() : "loop"));
		if (o.has("maxRevisions")) {
			b.maxRevisions(o.get("maxRevisions").getAsInt());
		}
		if (o.has("budgetUsd")) {
			b.budgetUsd(o.get("budgetUsd").getAsDouble());
		}
		if (o.has("maxMinutes")) {
			b.maxMinutes(o.get("maxMinutes").getAsDouble());
		}
		if (o.has("shipScore")) {
			b.shipScore(o.get("shipScore").getAsDouble());
		}
		if (o.has("model")) {
			b.model(o.get("model").getAsString());
		}
		if (o.has("effort")) {
			b.effort(o.get("effort").getAsString());
		}
		if (o.has("neighbours")) {
			b.neighbours(o.get("neighbours").getAsBoolean());
		}
		if (o.has("views")) {
			List<String> vs = new ArrayList<>();
			o.getAsJsonArray("views").forEach(v -> vs.add(v.getAsString()));
			b.views(vs);
		}
		if (o.has("extraCriteria")) {
			List<String> cs = new ArrayList<>();
			o.getAsJsonArray("extraCriteria").forEach(v -> cs.add(v.getAsString()));
			b.extraCriteria(cs);
		}
		return b.build();
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		ArchitectApi api = ArchitectApi.get();
		switch (a[0]) {
			case "critspec": {
				// critspec <base64 spec>: builds it (or answers the builder's refusal)
				try {
					CritiqueSpec s = spec(b64(a[1]));
					JsonObject o = new JsonObject();
					o.addProperty("mode", s.mode().name());
					o.addProperty("maxRevisions", s.maxRevisions());
					return o;
				} catch (IllegalArgumentException e) {
					JsonObject o = new JsonObject();
					o.addProperty("refused", e.getMessage());
					return o;
				}
			}
			case "critreq": {
				// critreq <key> <base64 design with critique: spec>: Designs.request with the request's critique
				return ApiTest.later("critreq:" + a[1], api.designs().request(ApiTestSets.design(b64(a[2]))).thenApply(JsonPrimitive::new));
			}
			case "critget": {
				// critget <designId>: the design with its critique (every round)
				return api.designs().get(a[1]).map(ApiTest::design).map(x -> (JsonElement) x).orElse(JsonNull.INSTANCE);
			}
			case "critentry": {
				// critentry <entryId>: Library.Entry.critique()
				return api.library().get(a[1]).flatMap(e -> e.critique()).map(ApiTestCritique::critique).map(x -> (JsonElement) x).orElse(JsonNull.INSTANCE);
			}
			case "critreport": {
				// critreport <key> <entryId> [base64 spec]: Designs.critique (report), completes with the critique
				CritiqueSpec s = a.length > 3 ? spec(b64(a[3])) : null;
				return ApiTest.later("critreport:" + a[1], api.designs().critique(a[2], s).thenApply(ApiTestCritique::critique));
			}
			case "critestimate": {
				// critestimate <key> <base64 design with critique?>: Designs.estimate(DesignRequest)
				return ApiTest.later("critestimate:" + a[1], api.designs().estimate(ApiTestSets.design(b64(a[2]))).thenApply(ApiTestCritique::estimate));
			}
			case "critgroupestimate": {
				return ApiTest.later("critgroupestimate:" + a[1], api.designs().estimate(ApiTestSets.groupRequest(b64(a[2]))).thenApply(
					ApiTestCritique::estimate));
			}
			case "critgroup": {
				// critgroup <key> <base64 group with critique? and items' critique?>
				return ApiTest.later("critgroup:" + a[1], api.designs().requestGroup(ApiTestSets.groupRequest(b64(a[2]))).thenApply(JsonPrimitive::new));
			}
			case "critgroupget": {
				return api.designs().group(a[1]).map(ApiTestCritique::groupCritiques).map(x -> (JsonElement) x).orElse(JsonNull.INSTANCE);
			}
			case "sheetbible": {
				// sheetbible <key> <base64 {prompt, name?}>: a bible request with the sheet critique
				JsonObject o = b64(a[2]);
				BibleRequest r = new BibleRequest(o.get("prompt").getAsString(), o.has("name") ? o.get("name").getAsString() : null, ApiTest.OWNER, null, null,
					null, List.of(), null, null).withSheetCritique(true);
				return ApiTest.later("sheetbible:" + a[1], api.bibles().request(r).thenApply(ApiTestSets::bibleJob));
			}
			case "bibleadmin": {
				// bibleadmin <id>: format, restraint, archived, critique
				return api.bibles().get(a[1]).map(ApiTestCritique::bibleAdmin).map(x -> (JsonElement) x).orElse(JsonNull.INSTANCE);
			}
			case "biblearchive": {
				// biblearchive <key> <id> <true|false>
				return ApiTest.later("biblearchive:" + a[1], api.bibles().archive(a[2], Boolean.parseBoolean(a[3])).thenApply(v -> new JsonPrimitive(true)));
			}
			case "bibledelete": {
				// bibledelete <key> <id> [owner|-]
				String owner = a.length > 3 && !a[3].equals("-") ? a[3] : null;
				return ApiTest.later("bibledelete:" + a[1], api.bibles().delete(a[2], owner).thenApply(vs -> {
					JsonArray arr = new JsonArray();
					vs.forEach(arr::add);
					return arr;
				}));
			}
			case "imagejob": {
				// imagejob <key>: two generated PNGs as blobs, then a structured job with them as images
				byte[] red = png(0xD0, 0x40, 0x30);
				byte[] blue = png(0x30, 0x60, 0xD0);
				var jobs = api.jobs();
				var f = jobs.putBlob("apitest.png", ApiTest.OWNER, red).thenCombine(jobs.putBlob("apitest.png", ApiTest.OWNER, blue), (r, b) -> List.of(
					new JobSpec.ImageRef(r, "a red square"), new JobSpec.ImageRef(b, "a blue square"))).thenCompose(imgs -> jobs.run(ApiTestJobs.spec(
						"structured", List.of()).images(imgs)));
				return ApiTest.later("imagejob:" + a[1], f.thenApply(JsonPrimitive::new));
			}
			case "imagejobrefused": {
				// imagejobrefused: nine images are refused by the record itself
				try {
					List<JobSpec.ImageRef> nine = java.util.Collections.nCopies(9, new JobSpec.ImageRef("b", "x"));
					ApiTestJobs.spec("structured", List.of()).images(nine);
					return new JsonPrimitive("accepted");
				} catch (IllegalArgumentException e) {
					JsonObject o = new JsonObject();
					o.addProperty("refused", e.getMessage());
					return o;
				}
			}
			default:
				throw new IllegalArgumentException("unknown step " + a[0]);
		}
	}

	// ------------------------------------------------------------------ JSON views

	static JsonObject round(Critique.Round r) {
		JsonObject o = new JsonObject();
		o.addProperty("n", r.n());
		o.addProperty("verdict", r.verdict());
		o.addProperty("overall", r.scored() ? r.overall() : null);
		JsonObject sc = new JsonObject();
		r.scores().forEach(sc::addProperty);
		o.add("scores", sc);
		o.addProperty("issues", r.issues().isEmpty() ? r.issueCount() : r.issues().size());
		o.addProperty("ship", r.ship());
		o.addProperty("usd", r.usd());
		o.addProperty("kept", r.kept());
		o.addProperty("error", r.error().orElse(null));
		return o;
	}

	static JsonObject critique(Critique c) {
		JsonObject o = new JsonObject();
		o.addProperty("mode", c.mode().name());
		o.addProperty("best", c.best());
		o.addProperty("end", c.end() == null ? null : c.end().name());
		o.addProperty("overall", c.scored() ? c.overall() : null);
		JsonObject sc = new JsonObject();
		c.scores().forEach(sc::addProperty);
		o.add("scores", sc);
		JsonArray is = new JsonArray();
		for (Critique.Issue i : c.openIssues()) {
			JsonObject j = new JsonObject();
			j.addProperty("priority", i.priority().name());
			j.addProperty("part", i.part());
			j.addProperty("view", i.view());
			j.addProperty("what", i.what());
			j.addProperty("fix", i.fix());
			is.add(j);
		}
		o.add("openIssues", is);
		JsonArray rs = new JsonArray();
		c.rounds().forEach(r -> rs.add(round(r)));
		o.add("rounds", rs);
		o.addProperty("criticUsd", c.critic().usd());
		o.addProperty("reviseUsd", c.revise().usd());
		o.addProperty("pending", c.pending().orElse(null));
		o.addProperty("stale", c.stale());
		return o;
	}

	static JsonObject estimate(Estimate e) {
		JsonObject o = ApiTestSets.estimate(e);
		o.addProperty("critique", e.critique());
		o.addProperty("critiqueUsdLow", e.critiqueUsdLow());
		o.addProperty("critiqueUsdHigh", e.critiqueUsdHigh());
		o.addProperty("critiqueMinutesLow", e.critiqueMinutesLow());
		o.addProperty("critiqueMinutesHigh", e.critiqueMinutesHigh());
		JsonArray items = new JsonArray();
		for (Estimate.Item i : e.items()) {
			JsonObject j = new JsonObject();
			j.addProperty("itemKey", i.itemKey());
			j.addProperty("usdHigh", i.usdHigh());
			j.addProperty("critique", i.critique());
			j.addProperty("critiqueUsdLow", i.critiqueUsdLow());
			j.addProperty("critiqueUsdHigh", i.critiqueUsdHigh());
			items.add(j);
		}
		o.add("items", items);
		return o;
	}

	static JsonObject groupCritiques(Group g) {
		JsonObject o = ApiTestSets.group(g);
		JsonObject cs = new JsonObject();
		for (Group.Item i : g.items()) {
			cs.add(i.itemKey(), i.critique().map(ApiTestCritique::critique).map(x -> (JsonElement) x).orElse(JsonNull.INSTANCE));
		}
		o.add("critiques", cs);
		return o;
	}

	static JsonObject bibleAdmin(Bible b) {
		JsonObject o = ApiTestSets.bible(b);
		o.addProperty("format", b.format());
		o.addProperty("archived", b.archived());
		JsonObject r = new JsonObject();
		JsonArray hero = new JsonArray();
		b.restraint().heroMotifs().forEach(hero::add);
		r.add("heroMotifs", hero);
		r.addProperty("accentShareMax", b.restraint().accentShareMax());
		r.addProperty("detailDensity", b.restraint().detailDensity());
		r.addProperty("windowsPerFacadeMin", b.restraint().windowsPerFacadeMin());
		o.add("restraint", r);
		b.critique().ifPresent(c -> o.add("critique", c));
		return o;
	}

	/** A design's critique summary for its DESIGN_ events (empty object when none). */
	static JsonObject designCritique(Design d) {
		return d.critique().map(ApiTestCritique::critique).orElseGet(JsonObject::new);
	}

	/** A 16x16 PNG of one colour (no AWT). */
	static byte[] png(int r, int g, int b) {
		try {
			ByteArrayOutputStream raw = new ByteArrayOutputStream();
			for (int y = 0; y < 16; y++) {
				raw.write(0);
				for (int x = 0; x < 16; x++) {
					raw.write(r);
					raw.write(g);
					raw.write(b);
				}
			}
			Deflater d = new Deflater();
			d.setInput(raw.toByteArray());
			d.finish();
			ByteArrayOutputStream z = new ByteArrayOutputStream();
			byte[] buf = new byte[4096];
			while (!d.finished()) {
				z.write(buf, 0, d.deflate(buf));
			}
			ByteArrayOutputStream out = new ByteArrayOutputStream();
			out.write(new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A});
			byte[] ihdr = {0, 0, 0, 16, 0, 0, 0, 16, 8, 2, 0, 0, 0};
			chunk(out, "IHDR", ihdr);
			chunk(out, "IDAT", z.toByteArray());
			chunk(out, "IEND", new byte[0]);
			return out.toByteArray();
		} catch (java.io.IOException e) {
			throw new IllegalStateException(e);
		}
	}

	private static void chunk(ByteArrayOutputStream out, String type, byte[] data) throws java.io.IOException {
		out.write(new byte[] {(byte) (data.length >>> 24), (byte) (data.length >>> 16), (byte) (data.length >>> 8), (byte) data.length});
		byte[] t = type.getBytes(StandardCharsets.US_ASCII);
		out.write(t);
		out.write(data);
		CRC32 crc = new CRC32();
		crc.update(t);
		crc.update(data);
		long c = crc.getValue();
		out.write(new byte[] {(byte) (c >>> 24), (byte) (c >>> 16), (byte) (c >>> 8), (byte) c});
	}
}
