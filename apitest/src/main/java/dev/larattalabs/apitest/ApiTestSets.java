package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.BibleJob;
import dev.larattalabs.architect.api.BibleRequest;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.Cost;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.GroupRequest;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.Reskin;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.api.SurvivalInfo;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import net.minecraft.commands.CommandSourceStack;

/**
 * The phase 4b steps of apitest (docs/CONTRACT.md "Phase 4b gate", the Java half): bibles, design groups, estimates,
 * re-skins, open types and the survival toggle, through {@code dev.larattalabs.architect.api} only. Structured arguments
 * come as base64 JSON (a command splits on spaces). Results go under keys for {@code /apitest get <key>}.
 */
final class ApiTestSets {
	private ApiTestSets() {
	}

	static void init() {
		SiteEvents.BIBLE_UPDATED.register(j -> ApiTest.event("BIBLE_UPDATED", bibleJob(j)));
		SiteEvents.BIBLE_DONE.register(j -> ApiTest.event("BIBLE_DONE", bibleJob(j)));
		SiteEvents.GROUP_UPDATED.register(g -> ApiTest.event("GROUP_UPDATED", group(g)));
		SiteEvents.GROUP_DONE.register(g -> {
			JsonObject o = group(g);
			// the done items' entries are loaded when GROUP_DONE fires
			JsonArray loaded = new JsonArray();
			g.items().forEach(i -> i.entryId().ifPresent(e -> {
				if (ArchitectApi.get().library().get(e).isPresent()) {
					loaded.add(e);
				}
			}));
			o.add("entriesLoaded", loaded);
			ApiTest.event("GROUP_DONE", o);
		});
		SiteEvents.RESKIN_DONE.register(r -> {
			JsonObject o = reskin(r);
			JsonArray loaded = new JsonArray();
			r.entries().forEach(e -> {
				if (ArchitectApi.get().library().get(e).isPresent()) {
					loaded.add(e);
				}
			});
			o.add("entriesLoaded", loaded);
			ApiTest.event("RESKIN_DONE", o);
		});
		SiteEvents.WORLD_MODE_CHANGED.register(i -> ApiTest.event("WORLD_MODE_CHANGED", survival(i, null)));
	}

	private static JsonObject b64(String s) {
		return JsonParser.parseString(new String(Base64.getDecoder().decode(s), StandardCharsets.UTF_8)).getAsJsonObject();
	}

	private static String s(JsonObject o, String k) {
		return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : null;
	}

	/** A design request from {type, style, name?, notes?, size?: [x,y,z], profile?: [..], ext?, model?, owner?, budgetUsd?, bible?}. */
	static DesignRequest design(JsonObject o) {
		int[] size = {15, 14, 15};
		if (o.has("size")) {
			JsonArray a = o.getAsJsonArray("size");
			size = new int[] {a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()};
		}
		List<String> profile = new ArrayList<>();
		if (o.has("profile")) {
			o.getAsJsonArray("profile").forEach(e -> profile.add(e.getAsString()));
		}
		DesignRequest r = new DesignRequest(s(o, "type"), s(o, "style") == null ? "rustic" : s(o, "style"), null, List.of(), new BlockSize(size[0],
			size[1], size[2]), s(o, "name"), s(o, "notes"), null, s(o, "owner") == null ? ApiTest.OWNER : s(o, "owner"),
			o.has("ext") ? o.getAsJsonObject("ext") : null, s(o, "model"), o.has("budgetUsd") ? o.get("budgetUsd").getAsDouble() : null, null, null);
		r = r.withProfile(profile);
		if (s(o, "bible") != null) {
			r = r.withBible(s(o, "bible"), o.has("bibleVersion") ? o.get("bibleVersion").getAsInt() : null);
		}
		return r;
	}

	/** {name, bible, bibleVersion?, concurrency?, budgetUsd?, ext?, items: [design & {itemKey?, role?, wave?, anchor?}]}. */
	static GroupRequest groupRequest(JsonObject o) {
		List<GroupRequest.Item> items = new ArrayList<>();
		for (JsonElement e : o.getAsJsonArray("items")) {
			JsonObject i = e.getAsJsonObject();
			items.add(new GroupRequest.Item(s(i, "itemKey"), design(i), GroupRequest.Role.of(s(i, "role")), i.has("wave") ? i.get("wave").getAsInt() : null,
				i.has("anchor") && i.get("anchor").getAsBoolean()));
		}
		return new GroupRequest(s(o, "name"), s(o, "bible"), o.has("bibleVersion") ? o.get("bibleVersion").getAsInt() : null, ApiTest.OWNER,
			o.has("ext") ? o.getAsJsonObject("ext") : null, o.has("concurrency") ? o.get("concurrency").getAsInt() : null,
			o.has("budgetUsd") ? o.get("budgetUsd").getAsDouble() : null, items);
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		ArchitectApi api = ArchitectApi.get();
		switch (a[0]) {
			case "bible": {
				// bible <key> <base64 {prompt, name?, scope?, seedPreset?, budgetUsd?}>
				JsonObject o = b64(a[2]);
				JsonObject ext = new JsonObject();
				ext.addProperty("apitest:bible", a[1]);
				BibleRequest r = new BibleRequest(s(o, "prompt"), s(o, "name"), ApiTest.OWNER, ext, null, o.has("budgetUsd") ? o.get("budgetUsd").getAsDouble()
					: null, List.of(), s(o, "scope"), s(o, "seedPreset"));
				return ApiTest.later("bible:" + a[1], api.bibles().request(r).thenApply(ApiTestSets::bibleJob));
			}
			case "biblerevise": {
				return ApiTest.later("biblerevise:" + a[1], api.bibles().revise(a[1], new String(Base64.getDecoder().decode(a[2]), StandardCharsets.UTF_8))
					.thenApply(ApiTestSets::bibleJob));
			}
			case "bibleestimate": {
				return ApiTest.later("bibleestimate", api.bibles().estimate(a.length > 1 ? BibleRequest.of(new String(Base64.getDecoder().decode(a[1]),
					StandardCharsets.UTF_8), null) : null).thenApply(ApiTestSets::estimate));
			}
			case "biblejob": {
				return api.bibles().job(a[1]).map(ApiTestSets::bibleJob).map(x -> (JsonElement) x).orElse(JsonNull.INSTANCE);
			}
			case "bibleget": {
				var b = a.length > 2 ? api.bibles().get(a[1], Integer.parseInt(a[2])) : api.bibles().get(a[1]);
				return b.map(ApiTestSets::bible).map(x -> (JsonElement) x).orElse(JsonNull.INSTANCE);
			}
			case "bibles": {
				JsonArray arr = new JsonArray();
				api.bibles().list(a.length > 1 && !a[1].equals("-") ? a[1] : null).forEach(b -> arr.add(bible(b)));
				return arr;
			}
			case "estimate": {
				// estimate <base64 group>
				return ApiTest.later("estimate", api.designs().estimate(groupRequest(b64(a[1]))).thenApply(ApiTestSets::estimate));
			}
			case "estimate1": {
				return ApiTest.later("estimate1", api.designs().estimate(design(b64(a[1]))).thenApply(ApiTestSets::estimate));
			}
			case "group": {
				// group <key> <base64 group>
				return ApiTest.later("group:" + a[1], api.designs().requestGroup(groupRequest(b64(a[2]))).thenApply(JsonPrimitive::new));
			}
			case "groupget": {
				return api.designs().group(a[1]).map(ApiTestSets::group).map(x -> (JsonElement) x).orElse(JsonNull.INSTANCE);
			}
			case "groups": {
				JsonArray arr = new JsonArray();
				api.designs().listGroups(a.length > 1 && !a[1].equals("-") ? a[1] : null).forEach(g -> arr.add(g.id()));
				return arr;
			}
			case "groupcancel": {
				return ApiTest.later("groupcancel:" + a[1], api.designs().cancelGroup(a[1]).thenApply(v -> new JsonPrimitive(true)));
			}
			case "groupextend": {
				return ApiTest.later("groupextend:" + a[1], api.designs().extendGroup(a[1], Double.parseDouble(a[2])).thenApply(v -> new JsonPrimitive(true)));
			}
			case "groupresume": {
				return ApiTest.later("groupresume:" + a[1], api.designs().resumeGroup(a[1]).thenApply(v -> new JsonPrimitive(true)));
			}
			case "opentype": {
				// opentype <key> <base64 design>
				return ApiTest.later("opentype:" + a[1], api.designs().request(design(b64(a[2]))).thenApply(JsonPrimitive::new));
			}
			case "reskin": {
				// reskin <key> <bibleId> group|bible|entries <value[,value]>
				Library.CollectionRef from = switch (a[3]) {
					case "group" -> Library.CollectionRef.ofGroup(a[4]);
					case "bible" -> Library.CollectionRef.ofBible(a[4], null);
					default -> Library.CollectionRef.ofEntries(List.of(a[4].split(",")));
				};
				return ApiTest.later("reskin:" + a[1], api.library().reskinCollection(a[2], null, from).thenApply(r -> {
					JsonObject o = reskin(r);
					o.addProperty("completedOn", Thread.currentThread().getName());
					JsonArray loaded = new JsonArray();
					r.entries().forEach(e -> api.library().get(e).ifPresent(x -> loaded.add(ApiTest.entry(x))));
					o.add("loaded", loaded);
					return o;
				}));
			}
			case "reskinvariant": {
				// reskinvariant <from> <bibleId>: Library.makeVariant with a bible
				return ApiTest.later("reskinvariant:" + a[1] + ":" + a[2], api.library().makeVariant(a[1], null, null, null, a[2]).thenApply(ApiTest::entry));
			}
			case "survival": {
				return survival(api.sites(src.getServer()).survival(), src);
			}
			default:
				throw new IllegalArgumentException("unknown step " + a[0]);
		}
	}

	// ------------------------------------------------------------------ JSON views

	static JsonObject survival(SurvivalInfo i, CommandSourceStack src) {
		JsonObject o = new JsonObject();
		o.addProperty("enabled", i.enabled());
		o.addProperty("blocksPerTick", i.blocksPerTick());
		o.addProperty("mayToggleNull", i.mayToggle(null));
		if (src != null) {
			o.addProperty("mayTogglePlayer", i.mayToggle(src.getPlayer()));
			o.addProperty("gameType", src.getServer().getDefaultGameType().getName());
			o.addProperty("world", src.getServer().getWorldData().getLevelName());
		}
		return o;
	}

	static JsonObject cost(Cost c) {
		JsonObject o = new JsonObject();
		o.addProperty("usd", c.usd());
		o.addProperty("turns", c.turns());
		return o;
	}

	static JsonObject estimate(Estimate e) {
		JsonObject o = new JsonObject();
		o.addProperty("usdLow", e.usdLow());
		o.addProperty("usdHigh", e.usdHigh());
		o.addProperty("minutesLow", e.minutesLow());
		o.addProperty("minutesHigh", e.minutesHigh());
		o.addProperty("basis", e.basis());
		return o;
	}

	static JsonObject bible(Bible b) {
		JsonObject o = new JsonObject();
		o.addProperty("id", b.id());
		o.addProperty("name", b.name());
		o.addProperty("version", b.version());
		JsonArray vs = new JsonArray();
		b.versions().forEach(vs::add);
		o.add("versions", vs);
		o.addProperty("builtin", b.builtin());
		o.addProperty("scope", b.scope());
		JsonObject roles = new JsonObject();
		b.roles().forEach(roles::addProperty);
		o.add("roles", roles);
		o.addProperty("proseChars", b.prose().map(String::length).orElse(0));
		o.addProperty("sheetPath", b.sheetPath().map(Object::toString).orElse(null));
		o.addProperty("sheetExists", b.sheetPath().map(java.nio.file.Files::isRegularFile).orElse(false));
		JsonArray cs = new JsonArray();
		b.components().forEach(cs::add);
		o.add("components", cs);
		o.addProperty("owner", b.owner().orElse(null));
		o.add("ext", b.ext());
		return o;
	}

	static JsonObject bibleJob(BibleJob j) {
		JsonObject o = new JsonObject();
		o.addProperty("id", j.id());
		o.addProperty("kind", j.kind());
		o.addProperty("bibleId", j.bibleId());
		o.addProperty("version", j.version());
		o.addProperty("status", j.status().name());
		o.addProperty("step", j.step());
		o.addProperty("error", j.error().orElse(null));
		o.add("cost", cost(j.cost()));
		o.addProperty("owner", j.owner().orElse(null));
		j.bible().ifPresent(b -> o.add("bible", bible(b)));
		return o;
	}

	static JsonObject group(Group g) {
		JsonObject o = new JsonObject();
		o.addProperty("id", g.id());
		o.addProperty("name", g.name());
		o.addProperty("bible", g.bible().id() + "@" + g.bible().version());
		o.addProperty("owner", g.owner().orElse(null));
		o.add("ext", g.ext());
		o.addProperty("status", g.status().name());
		o.addProperty("reason", g.reason().orElse(null));
		o.addProperty("budgetUsd", g.budgetUsd().orElse(null));
		o.addProperty("wave", g.wave());
		o.addProperty("done", g.done());
		o.addProperty("failed", g.failed());
		o.add("cost", cost(g.cost()));
		o.addProperty("usageLimitUntil", g.usageLimitUntil());
		o.addProperty("updatedAt", g.updatedAt());
		JsonArray items = new JsonArray();
		for (Group.Item i : g.items()) {
			JsonObject j = new JsonObject();
			j.addProperty("itemKey", i.itemKey());
			j.add("ext", i.ext());
			j.addProperty("designId", i.designId());
			j.addProperty("entryId", i.entryId().orElse(null));
			j.addProperty("status", i.status().name());
			j.addProperty("step", i.step());
			j.add("cost", cost(i.cost()));
			j.addProperty("wave", i.wave());
			j.addProperty("role", i.role().wire());
			j.addProperty("model", i.model());
			j.addProperty("type", i.type());
			j.addProperty("error", i.error().orElse(null));
			items.add(j);
		}
		o.add("items", items);
		return o;
	}

	static JsonObject reskin(Reskin r) {
		JsonObject o = new JsonObject();
		o.addProperty("id", r.id());
		o.addProperty("bible", r.bible().id() + "@" + r.bible().version());
		o.addProperty("status", r.status().name());
		o.addProperty("step", r.step());
		JsonArray e = new JsonArray();
		r.entries().forEach(e::add);
		o.add("entries", e);
		o.addProperty("done", r.done());
		o.addProperty("failed", r.failed());
		o.addProperty("error", r.error().orElse(null));
		return o;
	}
}
