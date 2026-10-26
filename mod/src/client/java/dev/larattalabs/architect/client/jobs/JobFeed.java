package dev.larattalabs.architect.client.jobs;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.BibleJob;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.apiimpl.Wire4b;
import dev.larattalabs.architect.client.design.MassingReview;
import dev.larattalabs.architect.client.design.SetFeature;
import dev.larattalabs.architect.client.dev.DevBridge;
import dev.larattalabs.architect.client.dev.Fields;
import dev.larattalabs.architect.client.hud.Keys;
import dev.larattalabs.architect.client.library.LibraryFeature;
import dev.larattalabs.architect.client.screen.ArchitectScreen;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.client.sidecar.SidecarState;
import dev.larattalabs.architect.jobs.JobRows;
import dev.larattalabs.labui.client.hud.Toasts;
import dev.larattalabs.labui.client.jobs.JobBoard;
import dev.larattalabs.labui.client.jobs.JobsScreen;
import dev.larattalabs.labui.ui.Guard;
import dev.larattalabs.labui.ui.JobCost;
import dev.larattalabs.labui.ui.JobRow;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;
import org.jspecify.annotations.Nullable;

/**
 * (J3, docs/JOBS-PANEL.md) Publishes Architect's jobs and cost ledger into lab-ui's Jobs &amp; spend panel ({@link JobBoard}, key K):
 * a {@link SidecarState} listener marks the feed dirty, and the next client tick maps the sidecar's records through the pure
 * {@link JobRows} and publishes them (at most once a tick; also once a second, so held rows and "today" stay current). Also the
 * toasts for a set, bible or parts job of the player's own that ends, each with its row ref. Client thread.
 */
public final class JobFeed {
	private static volatile boolean dirty = true;
	private static int ticks;
	private static boolean hostOnly;
	private static JobRows.@Nullable Feed last;
	/** The last status seen per set / bible job (a toast only on a transition this session saw: never for a record first seen ended). */
	private static final Map<String, String> SEEN = new HashMap<>();

	private JobFeed() {
	}

	public static void init() {
		JobBoard.install();
		JobBoard.name(JobRows.MOD, "Architect");
		Sidecar.state().addListener(new SidecarState.Listener() {
			@Override
			public void onLink(dev.larattalabs.architect.client.sidecar.LinkStatus link) {
				dirty = true;
			}

			@Override
			public void onSnapshot() {
				dirty = true;
			}

			@Override
			public void onStatus(SidecarState.Status status) {
				dirty = true;
			}

			@Override
			public void onDesign(SidecarState.@Nullable Design previous, SidecarState.Design design) {
				dirty = true;
			}

			@Override
			public void onVariant(SidecarState.@Nullable Variant previous, SidecarState.Variant variant) {
				dirty = true;
			}

			@Override
			public void onJob(JsonObject job) {
				dirty = true;
			}

			@Override
			public void onGroup(JsonObject group) {
				dirty = true;
				Guard.run("architect_mc:jobs.toast", () -> groupToast(group));
			}

			@Override
			public void onBibleJob(JsonObject job) {
				dirty = true;
				Guard.run("architect_mc:jobs.toast", () -> bibleToast(job));
			}

			@Override
			public void onMassing(JsonObject massing) {
				dirty = true;
			}

			@Override
			public void onMassingRemoved(String massingId, String reason) {
				dirty = true;
			}
		});
		ClientTickEvents.END_CLIENT_TICK.register(mc -> Guard.run("architect_mc:jobs.feed", () -> tick(mc)));
		DevBridge.register("dev.j3.state", 10_000, "{} - (J3) the Jobs panel: JobBoard.json(), Architect's published rows in full (state, step, "
			+ "needsYou, spent, budget, parent, actions, link), its ledger, hostOnly, the shown toast ref and the open panel's selection",
			(req, mc) -> DevBridge.onClient(mc, JobFeed::stateJson));
		DevBridge.register("dev.j3.open", 10_000, "{row?} - (J3) open the Jobs panel (on row when given, as a toast's ref does)",
			(req, mc) -> {
				String row = Fields.of(req).optStr("row", null);
				return DevBridge.onClient(mc, () -> {
					JobBoard.open(row);
					return stateJson();
				});
			});
	}

	private static void tick(Minecraft mc) {
		boolean host = mc.level != null && !mc.hasSingleplayerServer() && !Sidecar.connected();
		if (host != hostOnly) {
			hostOnly = host;
			JobBoard.hostOnly(JobRows.MOD, host);
		}
		if (++ticks % 20 != 0 && !dirty) {
			return;
		}
		dirty = false;
		publish();
	}

	/** Maps the sidecar's records and publishes rows and ledger (client thread). */
	public static void publish() {
		SidecarState s = Sidecar.state();
		JobRows.Input in = new JobRows.Input(s.groups(), s.bibleJobs(), s.designsRaw(), s.variants().stream().map(SidecarState.Variant::raw).toList(),
			s.massings(), s.jobsRaw(), s.status().usageLimitUntil(), System.currentTimeMillis());
		JobRows.Feed f = JobRows.of(in, JobFeed::action);
		last = f;
		JobBoard.publish(JobRows.MOD, f.rows());
		JobBoard.publishLedger(JobRows.MOD, f.ledger());
	}

	/** What a row's action does: Architect's own screens and sidecar calls, run on the client thread when the panel presses it. */
	static Runnable action(JobRows.Action a) {
		return switch (a.verb()) {
			case "open_designs" -> () -> ArchitectScreen.openJob(a.id());
			case "open_entry" -> () -> ArchitectScreen.openEntry(a.id());
			case "approve_massing" -> () -> {
				MassingReview.approve(a.id());
				dirty = true;
			};
			case "approve_set" -> () -> SetFeature.approve(a.id(), a.keys(), Map.of(), List.of());
			case "cancel_design" -> () -> Sidecar.designCancel(a.id());
			case "cancel_set" -> () -> SetFeature.cancelGroup(a.id());
			case "cancel_bible" -> () -> SetFeature.cancelBible(a.id());
			case "raise_set" -> () -> SetFeature.extendGroup(a.id(), a.usd()).thenRun(() -> {
				JsonObject g = Sidecar.state().group(a.id());
				if (g != null && Wire4b.group(g).status() == Group.Status.PAUSED_BUDGET) {
					SetFeature.resumeGroup(a.id());
				}
			});
			default -> () -> {
			};
		};
	}

	// ------------------------------------------------------------------ toasts (the player's own sets and bible / parts jobs ending)

	private static void groupToast(JsonObject raw) {
		Group g = Wire4b.group(raw);
		String prev = SEEN.put("g:" + g.id(), g.status().wire());
		if (prev == null || prev.equals(g.status().wire()) || !g.finished() || JobRows.foreignOwner(g.owner().orElse(null)) != null) {
			return;
		}
		String key = Keys.screen == null ? "B" : Keys.label(Keys.screen);
		String ref = JobRows.setRow(g.id());
		String spent = String.format(java.util.Locale.ROOT, "$%.2f (estimate)", g.cost().usd());
		switch (g.status()) {
			case DONE -> Toasts.push(Toasts.Spec.of(Toasts.Level.INFO, "Set done: " + g.name(), g.done() + " of " + g.items().size() + " designs in the "
				+ "Library" + (g.failed() > 0 ? ", " + g.failed() + " failed" : "") + " · " + spent).hint(key, "library").ref(ref));
			case FAILED -> Toasts.push(Toasts.Spec.of(Toasts.Level.WARN, "Set failed: " + g.name(), g.reason().orElse("no design of it was made"))
				.hint(key, "designs").bodyLines(3).ref(ref));
			default -> {
			}
		}
	}

	private static void bibleToast(JsonObject raw) {
		BibleJob b = Wire4b.bibleJob(raw);
		String st = b.status().name();
		String prev = SEEN.put("b:" + b.id(), st);
		if (prev == null || prev.equals(st) || !b.finished() || JobRows.foreignOwner(b.owner().orElse(null)) != null) {
			return;
		}
		boolean parts = b.request().has("parts") && b.request().get("parts").isJsonPrimitive() && b.request().get("parts").getAsBoolean();
		String name = b.bible().map(dev.larattalabs.architect.api.Bible::name).orElse(b.bibleId());
		String key = Keys.screen == null ? "B" : Keys.label(Keys.screen);
		String ref = JobRows.bibleRow(b.id());
		switch (b.status()) {
			case DONE -> Toasts.push(Toasts.Spec.of(Toasts.Level.INFO, (parts ? "Parts ready: " : "Style ready: ") + name, name + " v" + b.version()
				+ " is in the Style browser").hint(key, "designs").ref(ref));
			case FAILED -> Toasts.push(Toasts.Spec.of(Toasts.Level.WARN, (parts ? "Parts failed: " : "Style failed: ") + name, b.error().orElse(b.step()))
				.hint(key, "designs").bodyLines(3).ref(ref));
			default -> {
			}
		}
	}

	// ------------------------------------------------------------------ QA

	private static JsonObject obj(String kind, JsonObject o, JsonObject ownerOf, String def) {
		JsonObject x = new JsonObject();
		x.addProperty("kind", kind);
		for (String k : new String[] {"id", "status", "createdAt", "updatedAt"}) {
			if (o.has(k)) {
				x.add(k, o.get(k));
			}
		}
		x.addProperty("usd", o.has("cost") && o.get("cost").isJsonObject() ? dev.larattalabs.architect.api.Cost.fromJson(o.getAsJsonObject("cost")).usd() : 0);
		x.addProperty("owner", ownerOf.has("owner") && ownerOf.get("owner").isJsonPrimitive() ? ownerOf.get("owner").getAsString() : def);
		JsonObject req = o.has("request") && o.get("request").isJsonObject() ? o.getAsJsonObject("request") : null;
		x.addProperty("inGroup", req != null && req.has("group"));
		return x;
	}

	static JsonObject stateJson() {
		JsonObject o = JobBoard.json();
		JobRows.Feed f = last;
		JsonArray rows = new JsonArray();
		JsonArray ledger = new JsonArray();
		double sum = 0;
		if (f != null) {
			for (JobRow r : f.rows()) {
				JsonObject j = new JsonObject();
				j.addProperty("id", r.id());
				j.addProperty("kind", r.kind());
				j.addProperty("title", r.title());
				j.addProperty("state", r.state().name().toLowerCase(java.util.Locale.ROOT));
				j.addProperty("step", r.step());
				j.addProperty("needsYou", r.waiting());
				j.addProperty("spent", r.spentUsd());
				j.addProperty("budget", r.budgetUsd());
				j.addProperty("resetAt", r.resetAt());
				if (r.parentId() != null) {
					j.addProperty("parent", r.parentId());
				}
				j.addProperty("link", r.linkLabel());
				JsonArray acts = new JsonArray();
				if (r.approve() != null) {
					acts.add("approve");
				}
				if (r.cancel() != null) {
					acts.add("cancel");
				}
				if (r.raise() != null) {
					acts.add("raise");
				}
				j.add("actions", acts);
				rows.add(j);
			}
			for (JobCost c : f.ledger()) {
				JsonObject j = new JsonObject();
				j.addProperty("jobId", c.jobId());
				j.addProperty("owner", c.owner());
				j.addProperty("usd", c.usd());
				j.addProperty("at", c.at());
				ledger.add(j);
				sum += c.usd();
			}
		}
		o.add("architectRows", rows);
		o.add("architectLedger", ledger);
		o.addProperty("architectLedgerUsd", sum);
		// the sidecar's records as received, for the gate's own ledger sum (independent of JobRows): kind, id, cost, owner, group, times
		JsonArray objs = new JsonArray();
		SidecarState ss = Sidecar.state();
		for (JsonObject g : ss.groups()) {
			objs.add(obj("group", g, g, ""));
		}
		for (JsonObject d : ss.designsRaw()) {
			JsonObject r = d.has("request") && d.get("request").isJsonObject() ? d.getAsJsonObject("request") : new JsonObject();
			JsonObject x = obj("design", d, r, "");
			if (r.has("fromMassing")) {
				x.add("fromMassing", r.get("fromMassing"));
			}
			objs.add(x);
		}
		for (JsonObject b : ss.bibleJobs()) {
			objs.add(obj("bible", b, b.has("request") && b.get("request").isJsonObject() ? b.getAsJsonObject("request") : new JsonObject(), ""));
		}
		for (JsonObject j : ss.jobsRaw()) {
			objs.add(obj("job", j, j.has("spec") && j.get("spec").isJsonObject() ? j.getAsJsonObject("spec") : new JsonObject(), ""));
		}
		o.add("sidecarObjects", objs);
		o.addProperty("hostOnly", hostOnly);
		o.addProperty("refShown", Toasts.refShown());
		Minecraft mc = Minecraft.getInstance();
		if (mc.gui.screen() instanceof JobsScreen js) {
			JobRow sel = js.selectedRow();
			o.addProperty("panel", true);
			o.addProperty("selectedRow", sel == null ? null : sel.id());
			o.addProperty("debug", js.debugState());
		} else {
			o.addProperty("panel", false);
			o.addProperty("screen", mc.gui.screen() == null ? null : mc.gui.screen().getClass().getSimpleName());
		}
		return o;
	}
}
