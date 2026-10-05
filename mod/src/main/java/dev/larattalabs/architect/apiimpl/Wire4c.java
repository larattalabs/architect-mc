package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.Conformance;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.Massing;
import dev.larattalabs.architect.api.MassingRef;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * Phase 4c wire forms and views (docs/CONTRACT.md "Phase 4c contract" and "4c review folded in", sidecar/README.md "Phase 4c"):
 * the {@code Massing} record, a design's {@code massing} / {@code conformance}, a group item's stage, the {@code group.approve}
 * and {@code massing.redirect} acks, the context rule, and the dedupe keys of MASSING_DONE and GROUP_AWAITING_APPROVAL. Pure,
 * tested without a game. Internal.
 */
public final class Wire4c {
	/** A massing id ({@code mas_<slug>}). */
	public static final Pattern MASSING_ID = Pattern.compile("[a-z0-9_]{1,64}");

	private Wire4c() {
	}

	/** A {@code {id, version}} reference, or empty. */
	public static Optional<MassingRef> ref(@Nullable JsonElement e) {
		if (e == null || !e.isJsonObject()) {
			return Optional.empty();
		}
		JsonObject o = e.getAsJsonObject();
		String id = Wire4b.str(o, "id");
		return id == null || id.isBlank() ? Optional.empty() : Optional.of(new MassingRef(id, (int) Math.max(1, Wire4b.num(o, "version"))));
	}

	/** A design's {@code conformance {ok, errors, issues}}, or empty. */
	public static Optional<Conformance> conformance(@Nullable JsonElement e) {
		if (e == null || !e.isJsonObject()) {
			return Optional.empty();
		}
		JsonObject o = e.getAsJsonObject();
		return Optional.of(new Conformance(o.has("ok") && o.get("ok").isJsonPrimitive() && o.get("ok").getAsBoolean(), Wire4b.strings(o, "errors"),
			Wire4b.strings(o, "issues")));
	}

	/** A raw design's massing (a massing job), or empty. */
	public static Optional<MassingRef> designMassing(JsonObject design) {
		return ref(design.get("massing"));
	}

	/** {@code Massing} (massing.upsert, snapshot.massings, massing.list). */
	public static Massing massing(JsonObject o) {
		List<Integer> versions = new ArrayList<>();
		JsonElement vs = o.get("versions");
		if (vs != null && vs.isJsonArray()) {
			for (JsonElement v : vs.getAsJsonArray()) {
				if (v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber()) {
					versions.add(v.getAsInt());
				}
			}
		}
		versions.sort(null);
		JsonObject size = Wire4b.obj(o, "size");
		List<Path> previews = new ArrayList<>();
		for (String p : Wire4b.strings(o, "previews")) {
			previews.add(Path.of(p));
		}
		JsonObject red = o.has("redirect") && o.get("redirect").isJsonObject() ? o.getAsJsonObject("redirect") : null;
		JsonObject det = o.has("detail") && o.get("detail").isJsonObject() ? o.getAsJsonObject("detail") : null;
		String dir = Wire4b.str(o, "dir", "");
		String nbt = Wire4b.str(o, "nbt", "");
		return new Massing(Wire4b.str(o, "id", "?"), (int) Math.max(1, Wire4b.num(o, "version")), versions, Wire4b.str(o, "designId", "?"),
			Wire4b.str(o, "type", ""), Optional.ofNullable(Wire4b.str(o, "name")), Optional.ofNullable(Wire4b.str(o, "itemKey")),
			Wire4b.obj(o, "ext").deepCopy(), Optional.ofNullable(Wire4b.str(o, "owner")), Optional.ofNullable(Wire4b.str(o, "group")),
			Wire4b.pin(o.get("bible")), Wire4b.parts(o), new BlockSize((int) Wire4b.num(size, "x"), (int) Wire4b.num(size, "y"), (int) Wire4b.num(size,
				"z")), Wire4b.obj(o, "request").deepCopy(), Wire4b.cost(o), Path.of(dir), Path.of(nbt), previews,
			red == null ? Optional.empty() : Optional.of(new Massing.Redirect((int) Wire4b.num(red, "fromVersion"), Wire4b.str(red, "notes", ""))),
			det == null ? Optional.empty() : Optional.of(new Massing.Detail(Wire4b.str(det, "designId", "?"), Design.Status.of(Wire4b.str(det, "status")),
				Optional.ofNullable(Wire4b.str(det, "entryId")), Wire4b.num(det, "at"))), Wire4b.num(o, "createdAt"));
	}

	/** The record id a massing version is kept under: {@code id@version}. */
	public static String versionKey(JsonObject massing) {
		return Wire4b.str(massing, "id", "") + "@" + Math.max(1, Wire4b.num(massing, "version"));
	}

	/** MASSING_DONE fires once per {@code id@version@createdAt} (a sidecar whose state was wiped makes new versions). */
	public static String doneKey(JsonObject massing) {
		return versionKey(massing) + "@" + Wire4b.num(massing, "createdAt");
	}

	/** The ack of {@code group.approve}: {@code {groupId, approved: {k: designId}, redirected: {k: {designId, version}}, cancelled}}. */
	public static Group.Approval approval(JsonObject r) {
		Map<String, String> approved = new LinkedHashMap<>();
		Wire4b.obj(r, "approved").entrySet().forEach(e -> {
			if (e.getValue().isJsonPrimitive()) {
				approved.put(e.getKey(), e.getValue().getAsString());
			}
		});
		Map<String, Group.Redirected> redirected = new LinkedHashMap<>();
		Wire4b.obj(r, "redirected").entrySet().forEach(e -> {
			if (e.getValue().isJsonObject()) {
				redirected.put(e.getKey(), redirected(e.getValue().getAsJsonObject()));
			}
		});
		return new Group.Approval(Wire4b.str(r, "groupId", "?"), approved, redirected, Wire4b.strings(r, "cancelled"));
	}

	/** {@code {designId, version}} (a redirect's ack, or one entry of an approval's {@code redirected}). */
	public static Group.Redirected redirected(JsonObject r) {
		return new Group.Redirected(Wire4b.str(r, "designId", "?"), (int) Math.max(1, Wire4b.num(r, "version")));
	}

	/** The {@code group.approve} message. */
	public static JsonObject approveMessage(String groupId, List<String> approve, Map<String, String> redirect, List<String> cancel,
		@Nullable String owner) {
		JsonObject m = new JsonObject();
		m.addProperty("type", "group.approve");
		m.addProperty("groupId", groupId);
		if (!approve.isEmpty()) {
			JsonArray a = new JsonArray();
			approve.forEach(a::add);
			m.add("approve", a);
		}
		if (!redirect.isEmpty()) {
			JsonObject r = new JsonObject();
			redirect.forEach(r::addProperty);
			m.add("redirect", r);
		}
		if (!cancel.isEmpty()) {
			JsonArray c = new JsonArray();
			cancel.forEach(c::add);
			m.add("cancel", c);
		}
		if (owner != null) {
			m.addProperty("owner", owner);
		}
		return m;
	}

	/** Why a context is not accepted (null: it is): text of 1-4000 characters, or a JSON object of at most 4000 as JSON. */
	public static @Nullable String contextProblem(@Nullable JsonElement c) {
		if (c == null || c.isJsonNull()) {
			return null;
		}
		if (c.isJsonPrimitive() && c.getAsJsonPrimitive().isString()) {
			String t = c.getAsString().strip();
			if (t.isEmpty()) {
				return "the context is blank";
			}
			return t.length() > DesignRequest.MAX_CONTEXT ? "the context is " + t.length() + " characters (at most " + DesignRequest.MAX_CONTEXT + ")"
				: null;
		}
		if (c.isJsonObject()) {
			int n = c.toString().length();
			return n > DesignRequest.MAX_CONTEXT ? "the context is " + n + " characters as JSON (at most " + DesignRequest.MAX_CONTEXT + ")" : null;
		}
		return "a context is text or a JSON object";
	}

	/** The context as sent (text stripped). */
	public static JsonElement contextWire(JsonElement c) {
		return c.isJsonPrimitive() ? new com.google.gson.JsonPrimitive(c.getAsString().strip()) : c.deepCopy();
	}

	// ------------------------------------------------------------------ GROUP_AWAITING_APPROVAL

	/**
	 * The approval tokens of a group now: for each awaiting item, {@code itemKey=massingId@version} (the item's latest massing).
	 * Empty unless the group is awaiting_approval.
	 */
	public static List<String> awaitingTokens(Group g) {
		List<String> out = new ArrayList<>();
		if (g.status() != Group.Status.AWAITING_APPROVAL) {
			return out;
		}
		for (String k : g.awaiting()) {
			String m = g.item(k).flatMap(Group.Item::massing).map(MassingRef::toString).orElse("?");
			out.add(k + "=" + m);
		}
		return out;
	}
}
