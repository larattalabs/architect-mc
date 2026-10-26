package dev.larattalabs.architect.jobs;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.BibleJob;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.Massing;
import dev.larattalabs.architect.apiimpl.Wire4b;
import dev.larattalabs.architect.apiimpl.Wire4c;
import dev.larattalabs.labui.ui.JobCost;
import dev.larattalabs.labui.ui.JobRow;
import dev.larattalabs.labui.ui.JobState;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * (J3, docs/JOBS-PANEL.md) Architect's jobs as rows of lab-ui's Jobs &amp; spend panel, and its cost ledger. Pure: it reads the
 * sidecar's records as received (the client's {@code SidecarState}) and gets every action through {@link Actions}, so the
 * mapping is unit-tested without a game. The client's {@code JobFeed} publishes the result.
 *
 * <ul>
 * <li><b>Rows</b>: a set (group) each, a bible or parts job each, every design not in a set (design, massing, detail, remix, report,
 * polish, region) and every variant or import (no Claude cost). A set's items show in the set, as on the Designs tab.</li>
 * <li><b>Owner</b>: a job whose owner is another mod's ({@code steward_mc:settlement/7}) gets that owner as its parent, so it folds
 * under the owner's row once that mod publishes it. Such a job is the owner's to run: no Approve, Cancel or Raise here, and it never
 * waits for the player here (the owner's row says so).</li>
 * <li><b>Ledger</b>: one entry per distinct sidecar object that spends: a set (its items' cost; their designs get no entry), a design
 * outside a set, a bible job and a protocol-2 job. The cost is the SDK's estimate (notional under claude login); the panel labels the
 * total "estimate". Variants cost nothing and get none.</li>
 * </ul>
 */
public final class JobRows {
	public static final String MOD = "architect_mc";

	private JobRows() {
	}

	/** An action a row offers: what (approve_massing, approve_set, cancel_design, cancel_set, cancel_bible, raise_set, open_designs, open_entry), on what. */
	public record Action(String verb, String id, List<String> keys, double usd) {
		public Action {
			keys = List.copyOf(keys);
		}

		static Action of(String verb, String id) {
			return new Action(verb, id, List.of(), 0);
		}
	}

	/** Turns an {@link Action} into what runs it (the client: the screens and the sidecar link). */
	public interface Actions {
		Runnable run(Action a);
	}

	/**
	 * What the sidecar last sent (raw records, as received) and the clock.
	 *
	 * @param usageLimitUntil the sidecar status's usage-limit reset (epoch ms), 0 when none
	 */
	public record Input(List<JsonObject> groups, List<JsonObject> bibleJobs, List<JsonObject> designs, List<JsonObject> variants,
		List<JsonObject> massings, List<JsonObject> jobs, long usageLimitUntil, long now) {
	}

	/** The rows and the ledger. */
	public record Feed(List<JobRow> rows, List<JobCost> ledger) {
	}

	// ------------------------------------------------------------------ row ids (also the toasts' refs)

	public static String setRow(String groupId) {
		return MOD + ":set/" + groupId;
	}

	public static String designRow(String designId) {
		return MOD + ":design/" + designId;
	}

	public static String bibleRow(String jobId) {
		return MOD + ":bible/" + jobId;
	}

	public static String variantRow(String variantId) {
		return MOD + ":variant/" + variantId;
	}

	/** The owner when it is another mod's ({@code <modid>:<thing>}, not Architect's), else null: such a job folds under it. */
	public static @Nullable String foreignOwner(@Nullable String owner) {
		if (owner == null || owner.isBlank()) {
			return null;
		}
		int c = owner.indexOf(':');
		return c > 0 && !owner.substring(0, c).equals(MOD) ? owner : null;
	}

	/** A budget raise: half as much again, at least $1 over what is spent (as the Designs tab's "Budget → $N"). */
	public static double raiseTo(double budget, double spent) {
		return Math.ceil(Math.max(budget * 1.5, spent + 1));
	}

	// ------------------------------------------------------------------ the mapping

	public static Feed of(Input in, Actions act) {
		List<JobRow> rows = new ArrayList<>();
		List<JobCost> ledger = new ArrayList<>();
		long held = in.usageLimitUntil() > in.now() ? in.usageLimitUntil() : 0;
		for (JsonObject raw : in.groups()) {
			Group g = Wire4b.group(raw);
			rows.add(set(g, held, act));
			ledger.add(JobCost.of(g.id(), g.owner().orElse(""), g.cost().usd(), at(g.updatedAt(), g.createdAt())));
		}
		for (JsonObject raw : in.bibleJobs()) {
			BibleJob b = Wire4b.bibleJob(raw);
			rows.add(bible(b, in.now(), act));
			ledger.add(JobCost.of(b.id(), b.owner().orElse(""), b.cost().usd(), at(b.updatedAt(), b.createdAt())));
		}
		Map<String, Massing> byDesign = new HashMap<>();
		for (JsonObject raw : in.massings()) {
			Massing m = Wire4c.massing(raw);
			byDesign.put(m.designId(), m);
		}
		for (JsonObject d : in.designs()) {
			JsonObject req = obj(d, "request");
			if (req.has("group")) {
				continue; // in its set (row and ledger)
			}
			rows.add(design(d, byDesign, in.designs(), held, act));
			ledger.add(JobCost.of(str(d, "id", "?"), str(req, "owner", ""), usd(d), at(num(d, "updatedAt"), num(d, "createdAt"))));
		}
		for (JsonObject v : in.variants()) {
			rows.add(variant(v, act));
		}
		for (JsonObject j : in.jobs()) {
			JsonObject spec = obj(j, "spec");
			ledger.add(JobCost.of(str(j, "id", "?"), str(spec, "owner", ""), usd(j), at(num(j, "updatedAt"), num(j, "createdAt"))));
		}
		return new Feed(rows, ledger);
	}

	static JobRow set(Group g, long held, Actions act) {
		String parent = foreignOwner(g.owner().orElse(null));
		boolean ours = parent == null;
		boolean architectUi = g.approvalUi() == dev.larattalabs.architect.api.GroupRequest.ApprovalUi.ARCHITECT;
		int waiting = g.awaiting().size();
		boolean needsYou = ours && architectUi && waiting > 0 && !g.finished();
		JobState state = switch (g.status()) {
			case QUEUED -> JobState.QUEUED;
			case HELD_USAGE -> JobState.HELD;
			case PAUSED_BUDGET -> JobState.PAUSED_BUDGET;
			case AWAITING_APPROVAL -> needsYou ? JobState.NEEDS_YOU : JobState.RUNNING;
			case DONE -> JobState.DONE;
			case FAILED -> JobState.FAILED;
			case CANCELLED -> JobState.CANCELLED;
			default -> JobState.RUNNING;
		};
		StringBuilder step = new StringBuilder(g.done() + "/" + g.items().size() + " done");
		if (g.failed() > 0) {
			step.append(", ").append(g.failed()).append(" failed");
		}
		if (waiting > 0 && !g.finished()) {
			step.append(" · ").append(waiting).append(waiting == 1 ? " massing waits" : " massings wait").append(needsYou ? " for you" : architectUi
				? "" : " for " + modOf(g.owner().orElse("its owner")));
		}
		if (state == JobState.PAUSED_BUDGET || state == JobState.HELD || state == JobState.FAILED || state == JobState.CANCELLED) {
			g.reason().ifPresent(r -> step.append(" · ").append(r));
		}
		JobRow.Builder b = JobRow.builder(setRow(g.id()), "set", g.name(), state).step(step.toString()).needsYou(needsYou).spent(g.cost().usd())
			.created(g.createdAt()).parent(parent).link("Architect · Designs tab", act.run(Action.of("open_designs", g.id())));
		g.budgetUsd().ifPresent(u -> b.budget(u, "set"));
		if (state == JobState.HELD) {
			long until = g.usageLimitUntil() > 0 ? g.usageLimitUntil() : held;
			b.held("Claude usage limit", until);
		}
		if (g.finished()) {
			b.ended(at(g.updatedAt(), g.createdAt()));
		} else if (ours) {
			if (needsYou) {
				b.approve(waiting == 1 ? "Approve massing" : "Approve " + waiting + " massings", act.run(new Action("approve_set", g.id(), g.awaiting(), 0)));
			}
			if (architectUi || !g.massingFirst()) {
				b.cancel("Cancel set", act.run(Action.of("cancel_set", g.id())));
			}
			if (g.budgetUsd().isPresent()) {
				double to = raiseTo(g.budgetUsd().get(), g.cost().usd());
				b.raise(String.format(Locale.ROOT, "Budget → $%.0f", to), act.run(new Action("raise_set", g.id(), List.of(), to)));
			}
		}
		return b.build();
	}

	static JobRow bible(BibleJob bj, long now, Actions act) {
		String parent = foreignOwner(bj.owner().orElse(null));
		boolean parts = bj.request().has("parts") && bj.request().get("parts").isJsonPrimitive() && bj.request().get("parts").getAsBoolean();
		String name = bj.bible().map(dev.larattalabs.architect.api.Bible::name).orElse(bj.request().has("name") && bj.request().get("name")
			.isJsonPrimitive() ? bj.request().get("name").getAsString() : bj.bibleId());
		String title = parts ? "Parts for " + name + " v" + bj.version() : (bj.kind().equals("revise") ? "Revise " : "Bible ") + name + " v" + bj.version();
		JobState state = switch (bj.status()) {
			case QUEUED -> JobState.QUEUED;
			case DONE -> JobState.DONE;
			case FAILED -> JobState.FAILED;
			case CANCELLED -> JobState.CANCELLED;
			default -> JobState.RUNNING;
		};
		if (!state.ended() && bj.usageLimitUntil() > now) {
			state = JobState.HELD;
		}
		JobRow.Builder b = JobRow.builder(bibleRow(bj.id()), parts ? "parts" : "bible", title, state).step(bj.error().filter(e -> !e.isBlank())
			.map(JobRows::firstLine).orElse(bj.step())).spent(bj.cost().usd()).created(bj.createdAt()).parent(parent)
			.link("Architect · Designs tab", act.run(Action.of("open_designs", bj.id())));
		double budget = dbl(bj.request(), "budgetUsd");
		if (budget > 0) {
			b.budget(budget, "job");
		}
		if (state == JobState.HELD) {
			b.held("Claude usage limit", bj.usageLimitUntil());
		}
		if (bj.finished()) {
			b.ended(at(bj.updatedAt(), bj.createdAt()));
		} else if (parent == null) {
			b.cancel("Cancel", act.run(Action.of("cancel_bible", bj.id())));
		}
		return b.build();
	}

	static JobRow design(JsonObject d, Map<String, Massing> massingByDesign, List<JsonObject> designs, long held, Actions act) {
		String id = str(d, "id", "?");
		JsonObject req = obj(d, "request");
		String owner = str(req, "owner", null);
		String parent = foreignOwner(owner);
		String status = str(d, "status", "unknown").toLowerCase(Locale.ROOT);
		JobState state = switch (status) {
			case "queued" -> JobState.QUEUED;
			case "done" -> JobState.DONE;
			case "failed" -> JobState.FAILED;
			case "cancelled" -> JobState.CANCELLED;
			default -> JobState.RUNNING;
		};
		String kind = d.has("critiqueOf") ? "report" : "polish".equals(str(d, "kind", null)) ? "polish" : "region".equals(str(d, "kind", null)) ? "region"
			: d.has("massing") ? "massing" : req.has("fromMassing") ? "detail" : req.has("remix") ? "remix" : "design";
		String step = state == JobState.FAILED && str(d, "error", null) != null ? firstLine(str(d, "error", "")) : str(d, "step", "");
		boolean needsYou = false;
		Action approve = null;
		Massing m = "massing".equals(kind) && state == JobState.DONE ? massingByDesign.get(id) : null;
		if (m != null && m.group().isEmpty()) {
			String detailOf = m.detail().map(Massing.Detail::designId).orElse(detailFrom(designs, m));
			if (detailOf != null) {
				step = "Approved: the detail design " + detailOf + " is made from v" + m.version();
			} else if (parent == null) {
				needsYou = true;
				state = JobState.NEEDS_YOU;
				step = "Massing ready: v" + m.version() + ", " + m.parts().size() + " masses; approve it to start the detail";
				approve = new Action("approve_massing", m.id(), List.of(), 0);
			} else {
				step = "Massing ready: v" + m.version() + "; " + modOf(parent) + " approves it";
			}
		}
		if (!state.ended() && state != JobState.NEEDS_YOU && held > 0) {
			state = JobState.HELD;
		}
		String blueprint = str(d, "blueprintId", null);
		JobRow.Builder b = JobRow.builder(designRow(id), kind, title(req, kind), state).step(step).needsYou(needsYou).spent(usd(d))
			.created(num(d, "createdAt")).parent(parent);
		if (state == JobState.DONE && blueprint != null && !d.has("critiqueOf")) {
			b.link("Architect · Library: " + blueprint, act.run(Action.of("open_entry", blueprint)));
		} else {
			b.link("Architect · Designs tab", act.run(Action.of("open_designs", id)));
		}
		double budget = dbl(req, "budgetUsd");
		if (budget > 0) {
			b.budget(budget, "job");
		}
		if (state == JobState.HELD) {
			b.held("Claude usage limit", held);
		}
		if (state.ended()) {
			b.ended(at(num(d, "updatedAt"), num(d, "createdAt")));
		} else if (parent == null) {
			if (approve != null) {
				b.approve("Approve massing", act.run(approve));
			}
			if (state != JobState.NEEDS_YOU) {
				b.cancel("Cancel", act.run(Action.of("cancel_design", id)));
			}
		}
		return b.build();
	}

	static JobRow variant(JsonObject v, Actions act) {
		String id = str(v, "id", "?");
		String status = str(v, "status", "unknown").toLowerCase(Locale.ROOT);
		JobState state = switch (status) {
			case "queued" -> JobState.QUEUED;
			case "done" -> JobState.DONE;
			case "failed" -> JobState.FAILED;
			default -> JobState.RUNNING;
		};
		String from = str(v, "from", null);
		String path = str(v, "path", null);
		boolean imp = from == null && path != null || "import".equals(str(v, "kind", null)) || "import-schem".equals(str(v, "kind", null))
			|| v.has("imported") && v.get("imported").isJsonPrimitive() && v.get("imported").getAsBoolean();
		String name = str(v, "name", null);
		String title = name != null && !name.isBlank() ? name : imp ? "Import of " + (path == null ? "a structure" : Path.of(path).getFileName()) : "Variant of "
			+ (from == null ? "?" : from);
		String step = state == JobState.FAILED && str(v, "error", null) != null ? firstLine(str(v, "error", "")) : str(v, "step", "");
		String blueprint = str(v, "blueprintId", null);
		JobRow.Builder b = JobRow.builder(variantRow(id), imp ? "import" : "variant", title, state).step(step).created(num(v, "createdAt"));
		if (state == JobState.DONE && blueprint != null) {
			b.link("Architect · Library: " + blueprint, act.run(Action.of("open_entry", blueprint)));
		} else {
			b.link("Architect · Designs tab", act.run(Action.of("open_designs", id)));
		}
		if (state.ended()) {
			b.ended(at(num(v, "updatedAt"), num(v, "createdAt")));
		}
		return b.build();
	}

	/** A detail design made from this massing version (when the massing has no detail record yet), or null. */
	private static @Nullable String detailFrom(List<JsonObject> designs, Massing m) {
		for (JsonObject d : designs) {
			JsonObject r = obj(d, "request");
			if (m.id().equals(str(r, "fromMassing", null)) && (long) m.version() == (r.has("massingVersion") ? num(r, "massingVersion") : m.version())) {
				return str(d, "id", null);
			}
		}
		return null;
	}

	/** The request's name, else its type and style ("Cabin, rustic"). */
	static String title(JsonObject req, String kind) {
		String name = str(req, "name", null);
		if (name != null && !name.isBlank()) {
			return name;
		}
		String type = str(req, "type", kind);
		String style = str(req, "style", "");
		return (type.isEmpty() ? kind : Character.toUpperCase(type.charAt(0)) + type.substring(1)) + (style.isBlank() ? "" : ", " + style);
	}

	private static String modOf(String owner) {
		int c = owner.indexOf(':');
		return c > 0 ? owner.substring(0, c) : owner;
	}

	private static String firstLine(String s) {
		int n = s.indexOf('\n');
		return n < 0 ? s : s.substring(0, n);
	}

	private static long at(long updated, long created) {
		return updated > 0 ? updated : created;
	}

	private static double usd(JsonObject o) {
		return o.has("cost") && o.get("cost").isJsonObject() ? dev.larattalabs.architect.api.Cost.fromJson(o.getAsJsonObject("cost")).usd() : 0;
	}

	private static JsonObject obj(JsonObject o, String k) {
		return o.has(k) && o.get(k).isJsonObject() ? o.getAsJsonObject(k) : new JsonObject();
	}

	private static @Nullable String str(JsonObject o, String k, @Nullable String def) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() ? e.getAsString() : def;
	}

	private static long num(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsLong() : 0;
	}

	private static double dbl(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsDouble() : 0;
	}
}
