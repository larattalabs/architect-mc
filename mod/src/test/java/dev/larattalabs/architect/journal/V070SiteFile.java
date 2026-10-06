package dev.larattalabs.architect.journal;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.SiteGroupRec;
import java.util.ArrayList;
import java.util.List;

/**
 * Test only: 0.7.0's sites file reader and writer, vendored verbatim from tag {@code v0.7.0}
 * ({@code mod/src/main/java/dev/larattalabs/architect/site/Site.java}: {@code fileJson}, {@code FileData},
 * {@code fileFromJson}) so the downgrade cases run against what 0.7.0 does, not against what 0.8.0 does today. The record
 * codecs they call ({@code Site.fromJson/toJson}, {@code Site.Pending}, {@code SiteGroupRec}, {@code Construction},
 * {@code Anchors}) are unchanged between v0.7.0 and 0.8.0 ({@code git diff v0.7.0 -- site/Site.java site/SiteGroupRec.java
 * site/Construction.java placement/Anchors.java} is empty), so they are called rather than copied. 0.7.0 ignores the file's
 * {@code version}, reads only {@code sites}, {@code pending}, {@code groups}, {@code next} and {@code nextGroup}, and writes
 * only those: any 0.7.0 save drops every other field (docs/CONTRACT.md "Migration from 4d worlds", "Downgrade").
 */
final class V070SiteFile {
	private V070SiteFile() {
	}

	/** The sites file: {@code {"version":1, "next": 4, "sites": [...], "pending": [...]}}; {@code next} never goes back. */
	static JsonObject fileJson(List<Site> sites, int next, List<Site.Pending> pending) {
		return fileJson(sites, next, pending, List.of(), 1);
	}

	/** The sites file with the site groups (phase 4d): {@code "groups": [...]} and {@code "nextGroup"}. */
	static JsonObject fileJson(List<Site> sites, int next, List<Site.Pending> pending, List<SiteGroupRec> groups, int nextGroup) {
		JsonObject root = new JsonObject();
		root.addProperty("version", 1);
		root.addProperty("next", next);
		JsonArray arr = new JsonArray();
		sites.forEach(b -> arr.add(b.toJson()));
		root.add("sites", arr);
		if (!pending.isEmpty()) {
			JsonArray p = new JsonArray();
			pending.forEach(x -> p.add(x.toJson()));
			root.add("pending", p);
		}
		if (!groups.isEmpty() || nextGroup > 1) {
			JsonArray g = new JsonArray();
			groups.forEach(x -> g.add(x.toJson()));
			root.add("groups", g);
			root.addProperty("nextGroup", nextGroup);
		}
		return root;
	}

	/** 0.7.0's save of what it read: {@code fileJson(fileFromJson(root))}. */
	static JsonObject resave(JsonObject root) {
		FileData d = fileFromJson(root);
		return fileJson(d.sites(), d.next(), d.pending(), d.groups(), d.nextGroup());
	}

	/** Parsed sites file. */
	record FileData(List<Site> sites, int next, List<Site.Pending> pending, List<SiteGroupRec> groups, int nextGroup) {
		FileData {
			sites = List.copyOf(sites);
			pending = List.copyOf(pending);
			groups = List.copyOf(groups);
		}

		FileData(List<Site> sites, int next, List<Site.Pending> pending) {
			this(sites, next, pending, List.of(), 1);
		}
	}

	static FileData fileFromJson(JsonObject root) {
		List<Site> list = new ArrayList<>();
		int maxId = 0;
		for (JsonElement e : root.has("sites") ? root.getAsJsonArray("sites") : new JsonArray()) {
			Site b = Site.fromJson(e.getAsJsonObject());
			list.add(b);
			maxId = Math.max(maxId, Site.idNumber(b.id()));
		}
		List<Site.Pending> pending = new ArrayList<>();
		for (JsonElement e : root.has("pending") ? root.getAsJsonArray("pending") : new JsonArray()) {
			Site.Pending p = Site.Pending.fromJson(e.getAsJsonObject());
			pending.add(p);
			maxId = Math.max(maxId, Site.idNumber(p.site().id()));
		}
		List<SiteGroupRec> groups = new ArrayList<>();
		int maxGroup = 0;
		for (JsonElement e : root.has("groups") ? root.getAsJsonArray("groups") : new JsonArray()) {
			SiteGroupRec g = SiteGroupRec.fromJson(e.getAsJsonObject());
			groups.add(g);
			maxGroup = Math.max(maxGroup, Site.number(g.id(), 'g'));
		}
		int next = root.has("next") ? root.get("next").getAsInt() : 1;
		int nextGroup = root.has("nextGroup") ? root.get("nextGroup").getAsInt() : 1;
		return new FileData(list, Math.max(next, maxId + 1), pending, groups, Math.max(nextGroup, maxGroup + 1));
	}
}
