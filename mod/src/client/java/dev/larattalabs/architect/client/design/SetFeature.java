package dev.larattalabs.architect.client.design;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.apiimpl.ApiImpl;
import dev.larattalabs.architect.apiimpl.Wire4b;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.client.sidecar.SidecarLink;
import dev.larattalabs.architect.client.sidecar.SidecarState;
import dev.larattalabs.architect.client.text.TextModel;
import dev.larattalabs.architect.design.DesignSpec;
import dev.larattalabs.architect.design.SetSpec;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * Phase 4b on the client (docs/CONTRACT.md "Phase 4b contract"): the Design tab's "Design a set…" dialog model (a name, a
 * bible or a new one from a prompt, up to 24 items, concurrency, budget, the live estimate), and the actions the Library and
 * Designs tabs take on groups, bibles and re-skins ({@code design.group}, {@code design.estimate}, {@code bible.request},
 * {@code group.cancel|extend|resume}, {@code reskin.request}). Everything goes over the sidecar link and needs a helper with
 * the 4b features. Client thread.
 */
public final class SetFeature {
	/** How long the form must be still before the estimate is asked again. */
	static final long ESTIMATE_DEBOUNCE_MS = 600;

	/** One row of the set. */
	public static final class Item {
		public final TextModel type = new TextModel(40);
		public final TextModel name = new TextModel(DesignSpec.MAX_NAME + 10);
		public final TextModel notes = new TextModel(DesignSpec.MAX_NOTES);
		public boolean landmark;

		Item(String type, String name, boolean landmark) {
			this.type.set(type);
			this.name.set(name);
			this.landmark = landmark;
		}

		SetSpec.Item spec() {
			return new SetSpec.Item(type.value(), name.value(), landmark, notes.value());
		}
	}

	/** The dialog's model. */
	public static final class Form {
		public final TextModel name = new TextModel(SetSpec.MAX_NAME + 10);
		/** The bible picked (an id), or null. */
		public @Nullable String bible;
		/** "New from prompt…" picked: the prompt row shows. */
		public boolean newBible;
		public final TextModel prompt = new TextModel(2000);
		/** The bible job drafting the new bible, or null. */
		public @Nullable String bibleJob;
		public final List<Item> items = new ArrayList<>();
		public int concurrency = SetSpec.DEFAULT_CONCURRENCY;
		/** Null = no budget. */
		public @Nullable Double budgetUsd;
		/** (4c) Every building a massing first (default on; sent only to a helper with massings). */
		public boolean massingFirst = true;
		public int maxRedirects = SetSpec.DEFAULT_REDIRECTS;
		/** (4c) Text for every brief: the site, its purpose, the neighbours, the street. */
		public final TextModel context = new TextModel(SetSpec.MAX_CONTEXT + 50);
		/** (5a) "Critique and revise" for every building (default off; sent only to a helper with the loop). */
		public boolean critique = UiPrefs.critiqueByDefault();
		public int maxRevisions = dev.larattalabs.architect.design.CritiqueRules.DEFAULT_REVISIONS;
		public @Nullable String sendError;
		public boolean sending;
		// the live estimate
		@Nullable String estimateKey;
		long estimateChangedAt;
		@Nullable String estimateSentKey;
		public @Nullable Estimate estimate;
		public @Nullable String estimateError;
		public boolean estimating;

		Form() {
			name.set("New set");
			items.add(new Item("tower", "Watchtower", true));
			items.add(new Item("house", "House", false));
			items.add(new Item("tavern", "Tavern", false));
		}

		public SetSpec.Draft draft() {
			boolean m4c = has("massing");
			return new SetSpec.Draft(name.value(), bible, items.stream().map(Item::spec).toList(), concurrency, budgetUsd, massingFirst && m4c, maxRedirects,
				m4c ? context.value() : null);
		}

		public Map<String, String> errors() {
			return SetSpec.validate(draft());
		}

		public JsonObject groupJson() {
			JsonObject g = SetSpec.groupJson(draft(), bible == null ? null : bible(bible).map(Bible::name).orElse(null));
			// (5a) the items' critique (with massingFirst, the detail passes': the helper strips it from the massings)
			JsonObject c = dev.larattalabs.architect.design.CritiqueRules.spec(critique, maxRevisions, has("critique"));
			if (c != null) {
				g.add("critique", c);
			}
			return g;
		}

		public void addItem() {
			if (items.size() < SetSpec.MAX_ITEMS) {
				items.add(new Item("house", "", false));
			}
		}

		public void removeItem(int i) {
			if (i >= 0 && i < items.size()) {
				items.remove(i);
			}
		}
	}

	private static @Nullable Form form;
	private static @Nullable String lastGroup;
	private static @Nullable String message;
	private static boolean messageError;

	private SetFeature() {
	}

	public static void init() {
		Sidecar.state().addListener(new SidecarState.Listener() {
			@Override
			public void onBibleJob(JsonObject job) {
				Form f = form;
				if (f != null && f.bibleJob != null && f.bibleJob.equals(Wire4b.bibleJob(job).id())) {
					var j = Wire4b.bibleJob(job);
					if (j.status() == dev.larattalabs.architect.api.BibleJob.Status.DONE) {
						f.bible = j.bibleId();
						f.newBible = false;
						f.bibleJob = null;
					}
				}
			}
		});
	}

	// ------------------------------------------------------------------ bibles (installed + built in)

	/** Every bible: installed ones (latest version) then the built-in ones the helper lists. */
	public static List<Bible> bibles() {
		return ApiImpl.biblesImpl().all();
	}

	public static java.util.Optional<Bible> bible(String id) {
		return ApiImpl.biblesImpl().get(id);
	}

	/** Whether the helper has 4b {@code feature} ({@code bibles}, {@code design.groups}, {@code estimates}, {@code reskin}). */
	public static boolean has(String feature) {
		return Sidecar.connected() && Sidecar.state().protocol() >= 2 && Sidecar.state().features().contains(feature);
	}

	// ------------------------------------------------------------------ the dialog

	public static @Nullable Form form() {
		return form;
	}

	public static Form open() {
		if (form == null) {
			form = new Form();
		}
		form.sendError = null;
		return form;
	}

	public static void close() {
		form = null;
	}

	public static @Nullable String lastGroup() {
		return lastGroup;
	}

	public static @Nullable String message() {
		return message;
	}

	public static boolean messageError() {
		return messageError;
	}

	public static void say(@Nullable String m, boolean error) {
		message = m;
		messageError = error;
	}

	/** Drives the live estimate (call every frame while the dialog shows): asked once the form has been still a moment. */
	public static void tick() {
		Form f = form;
		if (f == null || !has("estimates")) {
			return;
		}
		Map<String, String> errors = f.errors();
		errors.remove("bible"); // the estimate needs a bible id only to name it
		String key = errors.isEmpty() ? withBible(f).toString() : null;
		long now = Util.getMillis();
		if (!java.util.Objects.equals(key, f.estimateKey)) {
			f.estimateKey = key;
			f.estimateChangedAt = now;
			return;
		}
		if (key == null || key.equals(f.estimateSentKey) || f.estimating || now - f.estimateChangedAt < ESTIMATE_DEBOUNCE_MS) {
			return;
		}
		f.estimateSentKey = key;
		f.estimating = true;
		JsonObject m = new JsonObject();
		m.addProperty("type", "design.estimate");
		m.add("group", withBible(f));
		Sidecar.link().send(m).whenComplete((ack, err) -> {
			f.estimating = false;
			if (err != null || !ack.ok() || ack.result() == null) {
				f.estimate = null;
				f.estimateError = err != null ? err.getMessage() : ack.error();
			} else {
				f.estimate = Wire4b.estimate(ack.result());
				f.estimateError = null;
			}
		});
	}

	/** The group JSON with a placeholder bible when none is picked yet (the estimate does not depend on it). */
	private static JsonObject withBible(Form f) {
		JsonObject g = f.groupJson();
		if (f.bible == null) {
			g.addProperty("bible", "oak");
		}
		return g;
	}

	/** "Draft bible": {@code bible.request {prompt}}; the new bible is picked when its job is done. */
	public static CompletableFuture<String> draftBible() {
		Form f = form;
		if (f == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("the set dialog is not open"));
		}
		if (f.prompt.value().isBlank()) {
			f.sendError = "Describe the place first (the bible's prompt)";
			return CompletableFuture.failedFuture(new IllegalStateException(f.sendError));
		}
		if (!has("bibles")) {
			f.sendError = "The helper does not make bibles (needs phase 4b)";
			return CompletableFuture.failedFuture(new IllegalStateException(f.sendError));
		}
		JsonObject r = new JsonObject();
		r.addProperty("prompt", f.prompt.value().strip());
		if (!f.name.value().isBlank()) {
			r.addProperty("name", f.name.value().strip().length() > 40 ? f.name.value().strip().substring(0, 40) : f.name.value().strip());
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "bible.request");
		m.add("request", r);
		f.sending = true;
		return Sidecar.link().send(m).handle((ack, err) -> {
			f.sending = false;
			String id = result(ack, err, "jobId", "Bible not started");
			if (id == null) {
				f.sendError = message;
				throw new CompletionException(new IllegalStateException(message));
			}
			f.bibleJob = id;
			f.sendError = null;
			say("Drafting a bible (" + id + "): the Designs tab shows its progress", false);
			return id;
		});
	}

	/** "Design the set": {@code design.group}; completes with the group id. */
	public static CompletableFuture<String> submit() {
		Form f = form;
		if (f == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("the set dialog is not open"));
		}
		Map<String, String> e = f.errors();
		if (!e.isEmpty()) {
			f.sendError = e.values().iterator().next();
			return CompletableFuture.failedFuture(new IllegalStateException(f.sendError));
		}
		if (!has("design.groups")) {
			f.sendError = "The helper does not design sets (needs phase 4b)";
			return CompletableFuture.failedFuture(new IllegalStateException(f.sendError));
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "design.group");
		m.add("group", f.groupJson());
		f.sending = true;
		return Sidecar.link().send(m).handle((ack, err) -> {
			f.sending = false;
			String id = result(ack, err, "groupId", "Not sent");
			if (id == null) {
				f.sendError = message;
				throw new CompletionException(new IllegalStateException(message));
			}
			lastGroup = id;
			Architect.LOGGER.info("Design set {} requested: {} item(s) with {}", id, f.items.size(), f.bible);
			say("Designing the set " + f.name.value().strip() + " (" + id + "): the Designs tab shows its progress", false);
			form = null;
			return id;
		});
	}

	/** The {@code result.<key>} of an ok ack, else null with {@link #message} saying why. */
	private static @Nullable String result(SidecarLink.@Nullable Ack ack, @Nullable Throwable err, String key, String what) {
		if (err != null) {
			say(what + ": " + (err instanceof CompletionException && err.getCause() != null ? err.getCause().getMessage() : err.getMessage()), true);
			return null;
		}
		if (!ack.ok()) {
			say(what + ": " + (ack.error() == null ? "refused by the helper" : ack.error()), true);
			return null;
		}
		JsonObject r = ack.result();
		if (r == null || !r.has(key)) {
			say(what + ": the helper sent no " + key, true);
			return null;
		}
		return r.get(key).getAsString();
	}

	// ------------------------------------------------------------------ groups, bibles, re-skins (Designs and Library tabs)

	private static CompletableFuture<SidecarLink.Ack> send(String type, java.util.function.Consumer<JsonObject> fill, String done) {
		JsonObject m = new JsonObject();
		m.addProperty("type", type);
		fill.accept(m);
		return Sidecar.link().send(m).whenComplete((ack, err) -> {
			if (err != null || !ack.ok()) {
				say(done + " failed: " + (err != null ? err.getMessage() : ack.error()), true);
			} else {
				say(done, false);
			}
		});
	}

	public static CompletableFuture<SidecarLink.Ack> cancelGroup(String id) {
		return send("group.cancel", m -> m.addProperty("groupId", id), "Cancelled the set " + id);
	}

	public static CompletableFuture<SidecarLink.Ack> resumeGroup(String id) {
		return send("group.resume", m -> m.addProperty("groupId", id), "Resumed the set " + id);
	}

	public static CompletableFuture<SidecarLink.Ack> extendGroup(String id, double budgetUsd) {
		return send("group.extend", m -> {
			m.addProperty("groupId", id);
			m.addProperty("budgetUsd", budgetUsd);
		}, String.format(java.util.Locale.ROOT, "The set %s may now spend $%.2f", id, budgetUsd));
	}

	/**
	 * (4c) A set's approval in the Designs tab ({@code group.approve}): approve, redirect (itemKey -> notes) or cancel items. No
	 * owner is sent: a set approved by its owner (approvalUi owner) refuses it, and the tab shows no buttons for one.
	 */
	public static CompletableFuture<SidecarLink.Ack> approve(String groupId, List<String> approve, Map<String, String> redirect, List<String> cancel) {
		JsonObject m = dev.larattalabs.architect.apiimpl.Wire4c.approveMessage(groupId, approve, redirect, cancel, null);
		List<String> what = new ArrayList<>();
		if (!approve.isEmpty()) {
			what.add("approved " + String.join(", ", approve) + " (the detail starts)");
		}
		if (!redirect.isEmpty()) {
			what.add("redirected " + String.join(", ", redirect.keySet()) + " (a new massing)");
		}
		if (!cancel.isEmpty()) {
			what.add("dropped " + String.join(", ", cancel));
		}
		String done = "Set " + groupId + ": " + String.join("; ", what);
		return Sidecar.link().send(m).whenComplete((ack, err) -> {
			if (err != null || !ack.ok()) {
				say("Not sent: " + (err != null ? err.getMessage() : ack.error()), true);
			} else {
				say(done, false);
			}
		});
	}

	public static CompletableFuture<SidecarLink.Ack> cancelBible(String jobId) {
		return send("bible.cancel", m -> m.addProperty("jobId", jobId), "Cancelled the bible job " + jobId);
	}

	/**
	 * "Re-skin collection…": {@code reskin.request {bibleId, from}} for a collection key ({@code bible:<id>} or
	 * {@code group:<id>}); completes with the reskin id.
	 */
	public static CompletableFuture<String> reskin(String collection, String bibleId) {
		if (!has("reskin")) {
			say("The helper does not re-skin collections (needs phase 4b)", true);
			return CompletableFuture.failedFuture(new IllegalStateException(message));
		}
		JsonObject from = new JsonObject();
		if (collection.startsWith(dev.larattalabs.architect.library.LibraryQuery.GROUP_PREFIX)) {
			from.addProperty("group", collection.substring(dev.larattalabs.architect.library.LibraryQuery.GROUP_PREFIX.length()));
		} else {
			from.addProperty("bible", collection.substring(dev.larattalabs.architect.library.LibraryQuery.BIBLE_PREFIX.length()));
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "reskin.request");
		m.addProperty("bibleId", bibleId);
		m.add("from", from);
		return Sidecar.link().send(m).handle((ack, err) -> {
			String id = result(ack, err, "reskinId", "Re-skin not started");
			if (id == null) {
				throw new CompletionException(new IllegalStateException(message));
			}
			int n = ack.result().has("variantIds") ? ack.result().getAsJsonArray("variantIds").size() : 0;
			say("Re-skinning " + n + " " + (n == 1 ? "entry" : "entries") + " with " + bible(bibleId).map(Bible::name).orElse(bibleId)
				+ " (" + id + "): no Claude, seconds each", false);
			return id;
		});
	}

	/** For the DevBridge: the dialog's state. */
	public static JsonObject stateJson() {
		JsonObject o = new JsonObject();
		Form f = form;
		o.addProperty("open", f != null);
		o.addProperty("lastGroup", lastGroup);
		o.addProperty("message", message);
		o.addProperty("messageError", messageError);
		if (f != null) {
			o.addProperty("name", f.name.value());
			o.addProperty("bible", f.bible);
			o.addProperty("newBible", f.newBible);
			o.addProperty("prompt", f.prompt.value());
			o.addProperty("bibleJob", f.bibleJob);
			o.addProperty("concurrency", f.concurrency);
			o.addProperty("budgetUsd", f.budgetUsd);
			o.addProperty("massingFirst", f.massingFirst);
			o.addProperty("critique", f.critique);
			o.addProperty("maxRevisions", f.maxRevisions);
			o.addProperty("maxRedirects", f.maxRedirects);
			o.addProperty("context", f.context.value());
			com.google.gson.JsonArray items = new com.google.gson.JsonArray();
			for (Item it : f.items) {
				JsonObject j = new JsonObject();
				j.addProperty("type", it.type.value());
				j.addProperty("name", it.name.value());
				j.addProperty("role", it.landmark ? "landmark" : "ordinary");
				j.addProperty("notes", it.notes.value());
				items.add(j);
			}
			o.add("items", items);
			JsonObject errs = new JsonObject();
			f.errors().forEach(errs::addProperty);
			o.add("errors", errs);
			o.addProperty("sendError", f.sendError);
			o.addProperty("estimating", f.estimating);
			o.addProperty("estimateError", f.estimateError);
			if (f.estimate != null) {
				JsonObject e = new JsonObject();
				e.addProperty("usdLow", f.estimate.usdLow());
				e.addProperty("usdHigh", f.estimate.usdHigh());
				e.addProperty("minutesLow", f.estimate.minutesLow());
				e.addProperty("minutesHigh", f.estimate.minutesHigh());
				e.addProperty("basis", f.estimate.basis());
				o.add("estimate", e);
				o.addProperty("estimateLine", dev.larattalabs.architect.design.CritiqueRules.estimateLine(f.estimate));
			}
			if (f.errors().isEmpty()) {
				o.add("request", f.groupJson());
			}
		}
		return o;
	}
}
