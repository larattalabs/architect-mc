package dev.larattalabs.architect.region;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.CheckReport;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.PrepareRequest;
import dev.larattalabs.architect.api.RealiseRequest;
import dev.larattalabs.architect.api.RegionDesignRequest;
import dev.larattalabs.architect.api.RegionPlan;
import dev.larattalabs.architect.api.RegionPlanRequest;
import dev.larattalabs.architect.api.RegionPreviews;
import dev.larattalabs.architect.api.RegionView;
import dev.larattalabs.architect.api.RemoveOptions;
import dev.larattalabs.architect.api.WaitAction;
import dev.larattalabs.architect.placement.Blueprints;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * {@code /architect region ...} (docs/CONTRACT.md phase 6b §6.6; N7: no Terrain tab): the region path from chat. Verdicts are
 * printed in chat; previews are written to the helper's plan dir and their paths printed as links (open file; click the
 * [copy] after it where the client won't open files from chat). The plan and region ids default to the last ones this
 * player made.
 * <pre>
 * /architect region plan &lt;program&gt; &lt;x0&gt; &lt;z0&gt; &lt;x1&gt; &lt;z1&gt; [params: JSON {..} or k=v ...; nocheck skips the checker]
 * /architect region check [planId]
 * /architect region preview [planId]
 * /architect region prepare [planId]
 * /architect region realise [planId] [fill]      fill: every lot gets the first library entry that fits it (round robin)
 * /architect region remove [regionId]
 * /architect region state [regionId]
 * /architect region design &lt;brief&gt;                 the claim: 200x200 centred on the player
 * /architect region nudge &lt;action&gt; [regionId]     MOVE_CLOSER | PREPARE | START_SIDECAR | APPROVE_STAGE | REPLAN
 * </pre>
 */
public final class RegionCommands {
	/** The design claim's side (blocks) around the player. */
	static final int DESIGN_CLAIM = 200;
	private static final Map<String, String> LAST_PLAN = new ConcurrentHashMap<>();
	private static final Map<String, String> LAST_REGION = new ConcurrentHashMap<>();

	private RegionCommands() {
	}

	public static void init() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registry, env) -> dispatcher.register(Commands.literal("architect")
			.then(Commands.literal("region")
				.then(Commands.literal("plan")
					.then(Commands.argument("program", StringArgumentType.word())
						.then(Commands.argument("x0", IntegerArgumentType.integer())
							.then(Commands.argument("z0", IntegerArgumentType.integer())
								.then(Commands.argument("x1", IntegerArgumentType.integer())
									.then(Commands.argument("z1", IntegerArgumentType.integer())
										.executes(ctx -> plan(ctx, ""))
										.then(Commands.argument("params", StringArgumentType.greedyString())
											.executes(ctx -> plan(ctx, StringArgumentType.getString(ctx, "params"))))))))))
				.then(Commands.literal("check").executes(ctx -> check(ctx, null))
					.then(Commands.argument("plan", StringArgumentType.word()).executes(ctx -> check(ctx, StringArgumentType.getString(ctx, "plan")))))
				.then(Commands.literal("preview").executes(ctx -> preview(ctx, null))
					.then(Commands.argument("plan", StringArgumentType.word()).executes(ctx -> preview(ctx, StringArgumentType.getString(ctx, "plan")))))
				.then(Commands.literal("prepare").executes(ctx -> prepare(ctx, null))
					.then(Commands.argument("plan", StringArgumentType.word()).executes(ctx -> prepare(ctx, StringArgumentType.getString(ctx, "plan")))))
				.then(Commands.literal("realise").executes(ctx -> realise(ctx, null, false))
					.then(Commands.literal("fill").executes(ctx -> realise(ctx, null, true)))
					.then(Commands.argument("plan", StringArgumentType.word()).executes(ctx -> realise(ctx, StringArgumentType.getString(ctx, "plan"), false))
						.then(Commands.literal("fill").executes(ctx -> realise(ctx, StringArgumentType.getString(ctx, "plan"), true)))))
				.then(Commands.literal("remove").executes(ctx -> remove(ctx, null))
					.then(Commands.argument("region", StringArgumentType.word()).suggests((ctx, b) -> {
						RegionsImpl.all().forEach(l -> b.suggest(l.rec().id));
						return b.buildFuture();
					}).executes(ctx -> remove(ctx, StringArgumentType.getString(ctx, "region")))))
				.then(Commands.literal("state").executes(ctx -> state(ctx, null))
					.then(Commands.argument("region", StringArgumentType.word()).executes(ctx -> state(ctx, StringArgumentType.getString(ctx, "region")))))
				.then(Commands.literal("design")
					.then(Commands.argument("brief", StringArgumentType.greedyString()).executes(RegionCommands::design)))
				.then(Commands.literal("nudge")
					.then(Commands.argument("action", StringArgumentType.word()).suggests((ctx, b) -> {
						for (WaitAction.Kind k : WaitAction.Kind.values()) {
							b.suggest(k.name().toLowerCase(Locale.ROOT));
						}
						return b.buildFuture();
					}).executes(ctx -> nudge(ctx, null))
						.then(Commands.argument("region", StringArgumentType.word()).executes(ctx -> nudge(ctx, StringArgumentType.getString(ctx, "region")))))))));
	}

	static String who(CommandSourceStack src) {
		return src.getTextName();
	}

	private static void say(CommandSourceStack src, Component c) {
		src.getServer().execute(() -> src.sendSuccess(() -> c, false));
	}

	private static void fail(CommandSourceStack src, String msg) {
		src.getServer().execute(() -> src.sendFailure(Component.literal(msg)));
	}

	private static String why(Throwable e) {
		Throwable c = e.getCause() != null && e instanceof java.util.concurrent.CompletionException ? e.getCause() : e;
		return c instanceof RegionsImpl.RegionException r ? r.reason + ": " + c.getMessage() : String.valueOf(c.getMessage());
	}

	private static @Nullable String planOf(CommandSourceStack src, @Nullable String given) {
		String id = given != null ? given : LAST_PLAN.get(who(src));
		if (id == null) {
			src.sendFailure(Component.literal("No plan: name one, or plan with /architect region plan first"));
		}
		return id;
	}

	/** Params: a JSON object, or k=v pairs (numbers, true/false, else strings); the word {@code nocheck} skips the checker. Pure. */
	static JsonObject params(String s, boolean[] check) {
		String t = s.trim();
		check[0] = true;
		if (t.isEmpty()) {
			return new JsonObject();
		}
		if (t.startsWith("{")) {
			return JsonParser.parseString(t).getAsJsonObject();
		}
		JsonObject o = new JsonObject();
		for (String part : t.split("\\s+")) {
			if (part.equals("nocheck")) {
				check[0] = false;
				continue;
			}
			int eq = part.indexOf('=');
			if (eq <= 0) {
				throw new IllegalArgumentException("params are JSON or k=v pairs (got '" + part + "')");
			}
			String k = part.substring(0, eq);
			String v = part.substring(eq + 1);
			if (v.equals("true") || v.equals("false")) {
				o.addProperty(k, Boolean.parseBoolean(v));
			} else if (v.matches("-?\\d+")) {
				o.addProperty(k, Long.parseLong(v));
			} else if (v.matches("-?\\d*\\.\\d+")) {
				o.addProperty(k, Double.parseDouble(v));
			} else {
				o.addProperty(k, v);
			}
		}
		return o;
	}

	private static int plan(CommandContext<CommandSourceStack> ctx, String raw) {
		CommandSourceStack src = ctx.getSource();
		String program = StringArgumentType.getString(ctx, "program");
		int x0 = IntegerArgumentType.getInteger(ctx, "x0");
		int z0 = IntegerArgumentType.getInteger(ctx, "z0");
		int x1 = IntegerArgumentType.getInteger(ctx, "x1");
		int z1 = IntegerArgumentType.getInteger(ctx, "z1");
		boolean[] check = {true};
		JsonObject params;
		try {
			params = params(raw, check);
		} catch (RuntimeException e) {
			src.sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
		ServerLevel level = src.getLevel();
		JsonObject ext = new JsonObject();
		if (!check[0]) {
			ext.addProperty(RegionsImpl.EXT_CHECK, false);
		}
		BoundingBox claim = new BoundingBox(Math.min(x0, x1), level.getMinY(), Math.min(z0, z1), Math.max(x0, x1), level.getMaxY(), Math.max(z0, z1));
		src.sendSuccess(() -> Component.literal("Planning " + program + " over " + claim.getXSpan() + "x" + claim.getZSpan() + (check[0]
			? " (with the checker and previews)" : "") + "..."), false);
		long t0 = System.currentTimeMillis();
		ArchitectApi.get().regions().plan(new RegionPlanRequest(program, params, level, claim, null, null, null, LoadPolicy.LOADED_ONLY, null, ext))
			.whenComplete((p, e) -> {
				if (e != null) {
					fail(src, "Plan failed: " + why(e));
					return;
				}
				LAST_PLAN.put(who(src), p.planId());
				say(src, Component.literal("Plan " + p.planId() + ": " + p.programId() + ", IR format " + p.irFormat() + ", irSha " + p.irSha().substring(0,
					Math.min(12, p.irSha().length())) + ", " + p.lots().size() + " lots, " + p.stages().size() + " stages, " + p.budget().cells() + " cells, "
					+ p.budget().chunksToGenerate() + " of " + p.budget().chunks() + " chunks to prepare (" + (System.currentTimeMillis() - t0) / 1000
					+ " s)"));
				verdict(src, p.report());
				previews(src, p.previews());
			});
		return 1;
	}

	static void verdict(CommandSourceStack src, @Nullable CheckReport r) {
		if (r == null) {
			say(src, Component.literal("Checker: not run").withStyle(ChatFormatting.GRAY));
			return;
		}
		say(src, Component.literal("Checker " + Wire6b.summary(r)).withStyle(r.ok() ? ChatFormatting.GREEN : ChatFormatting.RED));
		int n = 0;
		for (CheckReport.Finding f : r.findings()) {
			if (n++ >= 8) {
				say(src, Component.literal("  ... " + (r.findings().size() - 8) + " more (report.json in the plan dir)").withStyle(ChatFormatting.GRAY));
				break;
			}
			String at = f.sample().isEmpty() ? "" : " at " + f.sample().get(0).toShortString();
			say(src, Component.literal("  " + f.rule() + " " + f.severity() + (f.part() == null ? "" : " [" + f.part() + "]") + ": " + f.message() + at)
				.withStyle(f.error() ? ChatFormatting.RED : ChatFormatting.YELLOW));
		}
	}

	static void previews(CommandSourceStack src, @Nullable RegionPreviews p) {
		if (p == null) {
			return;
		}
		p.images().forEach((view, paths) -> {
			for (Path f : paths) {
				say(src, link(view.name().toLowerCase(Locale.ROOT) + ": ", f));
			}
		});
	}

	static MutableComponent link(String label, Path f) {
		String s = f.toString();
		return Component.literal(label).append(Component.literal(s).withStyle(st -> st.withUnderlined(true).withColor(ChatFormatting.AQUA)
			.withClickEvent(new ClickEvent.OpenFile(f)).withHoverEvent(new HoverEvent.ShowText(Component.literal("Open " + s))))).append(Component
				.literal(" [copy]").withStyle(st -> st.withColor(ChatFormatting.GRAY).withClickEvent(new ClickEvent.CopyToClipboard(s))));
	}

	private static int check(CommandContext<CommandSourceStack> ctx, @Nullable String given) {
		CommandSourceStack src = ctx.getSource();
		String id = planOf(src, given);
		if (id == null) {
			return 0;
		}
		src.sendSuccess(() -> Component.literal("Checking " + id + "..."), false);
		ArchitectApi.get().regions().check(id).whenComplete((r, e) -> {
			if (e != null) {
				fail(src, "Check failed: " + why(e));
			} else {
				verdict(src, r);
			}
		});
		return 1;
	}

	private static int preview(CommandContext<CommandSourceStack> ctx, @Nullable String given) {
		CommandSourceStack src = ctx.getSource();
		String id = planOf(src, given);
		if (id == null) {
			return 0;
		}
		src.sendSuccess(() -> Component.literal("Rendering the previews of " + id + "..."), false);
		ArchitectApi.get().regions().previews(id, Set.of(), List.of()).whenComplete((p, e) -> {
			if (e != null) {
				fail(src, "Previews failed: " + why(e));
			} else {
				say(src, Component.literal("Previews of " + id + " (in the plan dir):"));
				previews(src, p);
			}
		});
		return 1;
	}

	private static int prepare(CommandContext<CommandSourceStack> ctx, @Nullable String given) {
		CommandSourceStack src = ctx.getSource();
		String id = planOf(src, given);
		if (id == null) {
			return 0;
		}
		RegionsImpl.PlanRec p = RegionsImpl.planRec(id);
		String est = p == null ? "?" : WaitActions.estimate(p.chunksToGenerate(), Prepare.measuredRate(WaitActions.DEFAULT_RATE));
		src.sendSuccess(() -> Component.literal("Preparing " + id + ": " + est + " to generate..."), false);
		ArchitectApi.get().regions().prepare(new PrepareRequest(id, null)).whenComplete((v, e) -> {
			if (e != null) {
				fail(src, "Prepare failed: " + why(e));
			} else {
				say(src, Component.literal("Prepare of " + id + " " + v.state().name().toLowerCase(Locale.ROOT) + ": " + v.chunksGenerated() + " generated, "
					+ v.chunksMissing() + " missing"));
			}
		});
		return 1;
	}

	private static int realise(CommandContext<CommandSourceStack> ctx, @Nullable String given, boolean fill) {
		CommandSourceStack src = ctx.getSource();
		String id = planOf(src, given);
		if (id == null) {
			return 0;
		}
		Map<String, String> lots = fill ? RegionsImpl.fitLots(id, new ArrayList<>(Blueprints.ids())) : Map.of();
		ArchitectApi.get().regions().realise(new RealiseRequest(id, dev.larattalabs.architect.api.Mode.INSTANT, src.getPlayer(), lots, null, true, null,
			false, new JsonObject())).whenComplete((r, e) -> {
				if (e != null) {
					fail(src, "Realise refused: " + why(e));
				} else {
					LAST_REGION.put(who(src), r);
					say(src, Component.literal("Region " + r + " realising plan " + id + (fill ? " (" + lots.size() + " lots filled)" : " (lots stay pads)")
						+ "; /architect region state " + r));
				}
			});
		return 1;
	}

	private static @Nullable String regionOf(CommandSourceStack src, @Nullable String given) {
		String id = given != null ? given : LAST_REGION.get(who(src));
		if (id == null && RegionsImpl.all().size() == 1) {
			id = RegionsImpl.all().get(0).rec().id;
		}
		if (id == null) {
			src.sendFailure(Component.literal("No region: name one (" + RegionsImpl.all().stream().map(l -> l.rec().id).toList() + ")"));
		}
		return id;
	}

	private static int remove(CommandContext<CommandSourceStack> ctx, @Nullable String given) {
		CommandSourceStack src = ctx.getSource();
		String id = regionOf(src, given);
		if (id == null) {
			return 0;
		}
		src.sendSuccess(() -> Component.literal("Removing region " + id + "..."), false);
		ArchitectApi.get().regions().remove(id, new RemoveOptions(false, null, null)).whenComplete((r, e) -> {
			if (e != null) {
				fail(src, "Remove failed: " + why(e));
			} else {
				say(src, Component.literal("Region " + id + (r.removed() ? " removed" : " not removed: " + r)));
			}
		});
		return 1;
	}

	private static int state(CommandContext<CommandSourceStack> ctx, @Nullable String given) {
		CommandSourceStack src = ctx.getSource();
		String id = regionOf(src, given);
		if (id == null) {
			return 0;
		}
		RegionView v = ArchitectApi.get().regions().get(id).orElse(null);
		if (v == null) {
			src.sendFailure(Component.literal("No region " + id));
			return 0;
		}
		int done = v.stages().stream().mapToInt(s -> s.tilesDone()).sum();
		int total = v.stages().stream().mapToInt(s -> s.tilesTotal()).sum();
		src.sendSuccess(() -> Component.literal("Region " + id + ": " + v.state() + ", " + done + "/" + total + " tiles, " + v.cellsWritten() + " cells"
			+ (v.waiting() == null ? "" : "; waits " + v.waiting().reason() + ": " + v.waiting().message())), false);
		for (WaitAction a : v.actions()) {
			src.sendSuccess(() -> Component.literal("  nudge " + a.kind().name().toLowerCase(Locale.ROOT) + ": " + a.label()).withStyle(st -> st.withColor(
				ChatFormatting.AQUA).withClickEvent(new ClickEvent.SuggestCommand("/architect region nudge " + a.kind().name().toLowerCase(Locale.ROOT) + " "
					+ id))), false);
		}
		return 1;
	}

	private static int design(CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack src = ctx.getSource();
		String brief = StringArgumentType.getString(ctx, "brief").trim();
		if (brief.length() >= 2 && brief.startsWith("\"") && brief.endsWith("\"")) {
			brief = brief.substring(1, brief.length() - 1);
		}
		ServerLevel level = src.getLevel();
		int cx = (int) Math.floor(src.getPosition().x);
		int cz = (int) Math.floor(src.getPosition().z);
		int h = DESIGN_CLAIM / 2;
		BoundingBox claim = new BoundingBox(cx - h, level.getMinY(), cz - h, cx + h - 1, level.getMaxY(), cz + h - 1);
		String b = brief;
		src.sendSuccess(() -> Component.literal("Designing \"" + b + "\" over " + DESIGN_CLAIM + "x" + DESIGN_CLAIM + " around you..."), false);
		ArchitectApi.get().regions().design(new RegionDesignRequest(b, level, claim, null, List.of("M1", "M2", "M3", "M4"), null, null, null,
			new JsonObject())).whenComplete((id, e) -> {
				if (e != null) {
					fail(src, "Design refused: " + why(e));
					return;
				}
				say(src, Component.literal("Design " + id + " started; the pick lands in a moment"));
				watch(src, id, 0);
			});
		return 1;
	}

	/** Polls the design once a second (at most 10 minutes) and prints the pick, then the plan. */
	private static void watch(CommandSourceStack src, String designId, int n) {
		CompletableFuture.delayedExecutor(1, java.util.concurrent.TimeUnit.SECONDS).execute(() -> src.getServer().execute(() -> {
			var d = ArchitectApi.get().designs().get(designId).orElse(null);
			if (d != null && d.status().isFinal()) {
				JsonObject r = d.result().orElse(null);
				boolean waitPlan = r != null && "PICKED".equals(RegionsImpl.str(r, "outcome")) && !r.has("planId") && !r.has("planError") && n < 600;
				if (!waitPlan) {
					report(src, d, r);
					return;
				}
			}
			if (n < 600) {
				watch(src, designId, n + 1);
			} else {
				fail(src, "Design " + designId + ": no answer after 10 minutes");
			}
		}));
	}

	private static void report(CommandSourceStack src, dev.larattalabs.architect.api.Design d, @Nullable JsonObject r) {
		if (r == null) {
			fail(src, "Design " + d.id() + " " + d.status().name().toLowerCase(Locale.ROOT) + d.error().map(x -> ": " + x).orElse(""));
			return;
		}
		String outcome = RegionsImpl.str(r, "outcome");
		JsonElement params = r.get("params");
		say(src, Component.literal("Design " + d.id() + ": " + outcome + " " + RegionsImpl.str(r, "program") + (params == null ? "" : " " + params) + " ("
			+ RegionsImpl.str(r, "reason") + ")").withStyle("PICKED".equals(outcome) ? ChatFormatting.GREEN : ChatFormatting.YELLOW));
		if (r.has("planId")) {
			String planId = r.get("planId").getAsString();
			LAST_PLAN.put(who(src), planId);
			RegionsImpl.PlanRec p = RegionsImpl.planRec(planId);
			RegionPlan v = p == null ? null : RegionsImpl.view(p);
			say(src, Component.literal("Plan " + planId + " ready: /architect region prepare, then /architect region realise"));
			if (v != null) {
				verdict(src, v.report());
				previews(src, v.previews());
			}
		} else if (r.has("planError")) {
			fail(src, "The pick's plan failed: " + r.get("planError").getAsString());
		}
	}

	private static int nudge(CommandContext<CommandSourceStack> ctx, @Nullable String given) {
		CommandSourceStack src = ctx.getSource();
		String id = regionOf(src, given);
		if (id == null) {
			return 0;
		}
		WaitAction.Kind k;
		try {
			k = WaitAction.Kind.valueOf(StringArgumentType.getString(ctx, "action").toUpperCase(Locale.ROOT));
		} catch (IllegalArgumentException e) {
			src.sendFailure(Component.literal("The action is move_closer, prepare, start_sidecar, approve_stage or replan"));
			return 0;
		}
		ArchitectApi.get().regions().nudge(id, k).whenComplete((r, e) -> {
			if (e != null) {
				fail(src, "Nudge failed: " + why(e));
			} else {
				say(src, Component.literal("Nudge " + k.name().toLowerCase(Locale.ROOT) + ": " + (r.done() ? "done, " : "") + r.message()).withStyle(r.done()
					? ChatFormatting.GREEN : ChatFormatting.YELLOW));
			}
		});
		return 1;
	}
}
