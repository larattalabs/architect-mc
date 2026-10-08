package dev.larattalabs.architect.site;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.placement.Blueprints;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.phys.Vec3;
import dev.larattalabs.architect.survival.SurvivalWorld;
import org.jspecify.annotations.Nullable;

/**
 * {@code /architect} (docs/CONTRACT.md "Mod scope for phase 1"). No cheats needed: every player may run it, in every
 * game mode (phase 3 adds the survival rules; until then placement is free, as in AgentCraft).
 * <pre>
 * /architect                        open the Architect screen (singleplayer client)
 * /architect place &lt;id&gt; [rotation] [force]
 *                                   place in front of the player (ground row at the feet, entrance facing the player, its
 *                                   approach ending 2 blocks ahead; rotation overrides the automatic one)
 * /architect remove &lt;site&gt; [force|forget]
 *                                   restore the terrain (force: although the player's things are inside, they are lost;
 *                                   forget: only drop the record, the blocks stay)
 * /architect reload                 reload the library (bundled + yours)
 * /architect list                   list the library and the sites in this world
 * /architect survival [on|off]      show / change this world's survival toggle (changing it needs permission level 2)
 * /architect site finish &lt;site&gt;     build a construction site's remaining cells at once, free (permission 2, creative mode)
 * /architect site state &lt;site&gt;      a construction site's progress and what it still needs
 * /architect batches                the placement batches of this world (phase 4d)
 * /architect batch cancel &lt;batch&gt;   cancel a batch: placed items stay, the one placing rolls back, the rest are dropped
 * /architect groups                 the site groups and their stages
 * /architect group remove &lt;group&gt; [force]
 *                                   take a group's sites down, last placed first (force: a group another mod owns)
 * /architect group approve|skip|undo &lt;group&gt; &lt;stage&gt; [force]
 *                                   approve or skip a planned stage, or undo a placed one (force: although a later one is placed)
 * /architect budget [ms]            show / set the server time per tick placements may use (1-20 ms; setting needs permission 2)
 * /architect road &lt;x z&gt;... [width]   lay a road through these waypoints (the ground under each is the hint; width 1-5, default 3)
 * /architect remove &lt;road|cell site&gt; [both]
 *                                   remove a road or cell site (both: the sites covering it first)
 * /architect journal                the world journal: entries, size on disk, the cache
 * </pre>
 * In a survival world (docs/CONTRACT.md phase 3) place makes a construction site and remove deconstructs it.
 */
public final class SiteCommands {
	/** Blocks between the player and the near edge of a design placed in front of them. */
	public static final int GAP = 2;

	/**
	 * Opens the Architect screen for the player who ran {@code /architect}. The client installs it at start (it hops to
	 * the client thread itself); it stays null on a dedicated server.
	 */
	public static volatile @Nullable Consumer<ServerPlayer> screenOpener;

	private SiteCommands() {
	}

	public static void init() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registry, env) -> dispatcher.register(Commands.literal("architect")
			.executes(SiteCommands::open)
			.then(Commands.literal("list").executes(SiteCommands::list))
			.then(Commands.literal("reload").executes(ctx -> {
				Blueprints.reload(ctx.getSource().getServer());
				List<String> problems = Blueprints.lastProblems();
				ctx.getSource().sendSuccess(() -> Component.literal("Reloaded " + Blueprints.ids().size() + " design(s) " + Blueprints.ids()
					+ (problems.isEmpty() ? "" : "; skipped " + problems.size() + ":")), false);
				for (String p : problems) {
					ctx.getSource().sendFailure(Component.literal("  " + p));
				}
				return Blueprints.ids().size();
			}))
			.then(Commands.literal("place")
				.then(Commands.argument("id", StringArgumentType.word())
					.suggests((ctx, b) -> {
						Blueprints.ids().forEach(b::suggest);
						return b.buildFuture();
					})
					.executes(SiteCommands::place)
					.then(Commands.argument("args", StringArgumentType.greedyString()).executes(SiteCommands::place))))
			.then(Commands.literal("remove")
				.then(Commands.argument("site", StringArgumentType.word())
					.suggests((ctx, b) -> {
						Sites.all().forEach(x -> b.suggest(x.id()));
						return b.buildFuture();
					})
					.executes(ctx -> remove(ctx, false, false))
					.then(Commands.literal("forget").executes(ctx -> remove(ctx, true, false)))
					.then(Commands.literal("force").executes(ctx -> remove(ctx, false, true)))))
			.then(Commands.literal("survival")
				.executes(SiteCommands::survivalShow)
				.then(Commands.literal("on").executes(ctx -> survivalSet(ctx, true)))
				.then(Commands.literal("off").executes(ctx -> survivalSet(ctx, false))))
			.then(Commands.literal("site")
				.then(Commands.literal("finish")
					.then(Commands.argument("site", StringArgumentType.word()).suggests((ctx, b) -> {
						Sites.all().stream().filter(Site::building).forEach(x -> b.suggest(x.id()));
						return b.buildFuture();
					}).executes(SiteCommands::finish)))
				.then(Commands.literal("state")
					.then(Commands.argument("site", StringArgumentType.word()).suggests((ctx, b) -> {
						Sites.all().stream().filter(x -> x.construction() != null).forEach(x -> b.suggest(x.id()));
						return b.buildFuture();
					}).executes(SiteCommands::siteState)))
				// phase 5b: /architect site update <id> [version] [keep|overwrite], revert <id> <version>, history <id>
				.then(Commands.literal("update")
					.then(Commands.argument("site", StringArgumentType.word()).suggests(SiteCommands::siteIds)
						.executes(ctx -> update(ctx, 0, "keep"))
						.then(Commands.argument("version", com.mojang.brigadier.arguments.IntegerArgumentType.integer(1))
							.executes(ctx -> update(ctx, com.mojang.brigadier.arguments.IntegerArgumentType.getInteger(ctx, "version"), "keep"))
							.then(Commands.literal("keep").executes(ctx -> update(ctx, com.mojang.brigadier.arguments.IntegerArgumentType.getInteger(ctx,
								"version"), "keep")))
							.then(Commands.literal("overwrite").executes(ctx -> update(ctx, com.mojang.brigadier.arguments.IntegerArgumentType.getInteger(ctx,
								"version"), "overwrite"))))))
				.then(Commands.literal("revert")
					.then(Commands.argument("site", StringArgumentType.word()).suggests(SiteCommands::siteIds)
						.then(Commands.argument("version", com.mojang.brigadier.arguments.IntegerArgumentType.integer(1))
							.executes(ctx -> revert(ctx, com.mojang.brigadier.arguments.IntegerArgumentType.getInteger(ctx, "version"))))))
				.then(Commands.literal("history")
					.then(Commands.argument("site", StringArgumentType.word()).suggests(SiteCommands::siteIds).executes(SiteCommands::history))))
			.then(Commands.literal("batches").executes(SiteCommands::batches))
			.then(Commands.literal("batch")
				.then(Commands.literal("cancel")
					.then(Commands.argument("batch", StringArgumentType.word()).suggests((ctx, b) -> {
						Batches.all().stream().filter(x -> x.running()).forEach(x -> b.suggest(x.id));
						return b.buildFuture();
					}).executes(SiteCommands::batchCancel))))
			.then(Commands.literal("groups").executes(SiteCommands::groups))
			.then(Commands.literal("group")
				.then(Commands.literal("remove")
					.then(Commands.argument("group", StringArgumentType.word()).suggests(SiteCommands::suggestGroups)
						.executes(ctx -> groupRemove(ctx, false))
						.then(Commands.literal("force").executes(ctx -> groupRemove(ctx, true)))))
				.then(stageCommand("approve"))
				.then(stageCommand("skip"))
				.then(stageCommand("undo")))
			.then(Commands.literal("road")
				.then(Commands.argument("points", StringArgumentType.greedyString()).executes(SiteCommands::road)))
			.then(Commands.literal("journal").executes(SiteCommands::journal))
			.then(Commands.literal("budget")
				.executes(ctx -> budget(ctx, -1))
				.then(Commands.argument("ms", com.mojang.brigadier.arguments.IntegerArgumentType.integer(1, 20))
					.executes(ctx -> budget(ctx, com.mojang.brigadier.arguments.IntegerArgumentType.getInteger(ctx, "ms")))))));
	}

	// ------------------------------------------------------------------ phase 4d: batches, groups, stages, budget

	private static java.util.concurrent.CompletableFuture<com.mojang.brigadier.suggestion.Suggestions> suggestGroups(
		CommandContext<CommandSourceStack> ctx, com.mojang.brigadier.suggestion.SuggestionsBuilder b) {
		Sites.groups().stream().filter(g -> !SiteGroupRec.REMOVED.equals(g.state())).forEach(g -> b.suggest(g.id()));
		return b.buildFuture();
	}

	private static com.mojang.brigadier.builder.LiteralArgumentBuilder<CommandSourceStack> stageCommand(String verb) {
		return Commands.literal(verb)
			.then(Commands.argument("group", StringArgumentType.word()).suggests(SiteCommands::suggestGroups)
				.then(Commands.argument("stage", StringArgumentType.word()).suggests((ctx, b) -> {
					SiteGroupRec g = Sites.group(StringArgumentType.getString(ctx, "group"));
					if (g != null) {
						g.stageNames().forEach(b::suggest);
					}
					return b.buildFuture();
				})
					.executes(ctx -> stage(ctx, verb, false))
					.then(Commands.literal("force").executes(ctx -> stage(ctx, verb, true)))));
	}

	private static int batches(CommandContext<CommandSourceStack> ctx) {
		List<dev.larattalabs.architect.batch.QBatch> all = Batches.all();
		if (all.isEmpty()) {
			ctx.getSource().sendSuccess(() -> Component.literal("No placement batches in this world"), false);
			return 0;
		}
		for (dev.larattalabs.architect.batch.QBatch b : all) {
			long placed = b.items.stream().filter(i -> i.status == dev.larattalabs.architect.batch.QItem.Status.PLACED).count();
			long failed = b.items.stream().filter(i -> i.status == dev.larattalabs.architect.batch.QItem.Status.FAILED).count();
			long waiting = b.items.stream().filter(i -> i.status == dev.larattalabs.architect.batch.QItem.Status.WAITING).count();
			ctx.getSource().sendSuccess(() -> Component.literal(b.id + " (group " + b.group + "): " + b.status.name().toLowerCase(Locale.ROOT) + ", "
				+ placed + "/" + b.items.size() + " placed" + (failed > 0 ? ", " + failed + " failed" : "") + (waiting > 0 ? ", " + waiting + " waiting" : "")
				+ (b.note.isEmpty() ? "" : " (" + b.note + ")")), false);
		}
		return all.size();
	}

	private static int batchCancel(CommandContext<CommandSourceStack> ctx) {
		String id = StringArgumentType.getString(ctx, "batch");
		if (Batches.get(id) == null) {
			ctx.getSource().sendFailure(Component.literal("No batch " + id + " (see /architect batches)"));
			return 0;
		}
		CommandSourceStack src = ctx.getSource();
		Batches.cancel(src.getServer(), id).whenComplete((b, e) -> src.sendSuccess(() -> Component.literal(e != null ? "Cancelling " + id + " failed: "
			+ e.getMessage() : "Batch " + id + " cancelled: placed items stay, the rest were dropped"), false));
		return 1;
	}

	private static int groups(CommandContext<CommandSourceStack> ctx) {
		List<SiteGroupRec> all = Sites.groups();
		if (all.isEmpty()) {
			ctx.getSource().sendSuccess(() -> Component.literal("No site groups in this world"), false);
			return 0;
		}
		for (SiteGroupRec g : all) {
			StringBuilder st = new StringBuilder();
			for (SiteGroupRec.StageRec x : g.stages()) {
				st.append(st.isEmpty() ? "" : ", ").append(x.name()).append(" ").append(x.state().name().toLowerCase(Locale.ROOT));
			}
			ctx.getSource().sendSuccess(() -> Component.literal(g.id() + (g.owner() == null ? "" : " (owned by " + g.owner() + ")") + ": " + g.state() + ", "
				+ g.sites().size() + " site(s) " + g.sites() + "; stages: " + st), false);
		}
		return all.size();
	}

	private static int groupRemove(CommandContext<CommandSourceStack> ctx, boolean force) {
		String id = StringArgumentType.getString(ctx, "group");
		CommandSourceStack src = ctx.getSource();
		Groups.removeGroup(src.getServer(), id, null, force).whenComplete((r, e) -> {
			if (e != null) {
				src.sendFailure(Component.literal(e.getMessage()));
			} else {
				src.sendSuccess(() -> Component.literal(r.removed() ? "Group " + id + " removed: every site restored" : "Group " + id + " was not removed: "
					+ String.join("; ", r.blockers())), false);
			}
		});
		return 1;
	}

	private static int stage(CommandContext<CommandSourceStack> ctx, String verb, boolean force) {
		String g = StringArgumentType.getString(ctx, "group");
		String st = StringArgumentType.getString(ctx, "stage");
		CommandSourceStack src = ctx.getSource();
		try {
			switch (verb) {
				case "approve" -> Groups.approve(src.getServer(), g, st);
				case "skip" -> Groups.skip(src.getServer(), g, st);
				default -> {
					Groups.undoStage(src.getServer(), g, st, force).whenComplete((r, e) -> {
						if (e != null) {
							src.sendFailure(Component.literal("Undo refused: " + (e.getCause() != null ? e.getCause().getMessage() : e.getMessage())));
						} else {
							src.sendSuccess(() -> Component.literal(r.removed() ? "Stage " + st + " of " + g + " undone" : "Stage " + st + " was not undone: "
								+ String.join("; ", r.blockers())), false);
						}
					});
					return 1;
				}
			}
		} catch (IllegalArgumentException | IllegalStateException e) {
			src.sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
		src.sendSuccess(() -> Component.literal("Stage " + st + " of " + g + ": " + verb + (verb.equals("skip") ? "ped" : "d")), false);
		return 1;
	}

	private static int budget(CommandContext<CommandSourceStack> ctx, int ms) {
		CommandSourceStack src = ctx.getSource();
		if (ms > 0) {
			if (!gamemaster(src)) {
				src.sendFailure(Component.literal("Changing the placement budget needs permission level 2 (cheats on, or an operator)"));
				return 0;
			}
			SurvivalWorld.setPlacementBudget(src.getServer(), ms);
		}
		int now = SurvivalWorld.placementBudgetMs();
		src.sendSuccess(() -> Component.literal("Placements may use " + now + " ms of server time per tick (1-20; /architect budget <ms>)"), false);
		return now;
	}

	private static int survivalShow(CommandContext<CommandSourceStack> ctx) {
		boolean on = SurvivalWorld.on();
		ctx.getSource().sendSuccess(() -> Component.literal("Survival construction sites are " + (on ? "on" : "off") + " in this world"
			+ (on ? ": Place makes a construction site that builds as its crate is fed" : ": placement is instant")
			+ ". Changing it needs cheats (permission level 2): /architect survival on|off"), false);
		return on ? 1 : 0;
	}

	/** Permission level 2 (cheats on, or an operator): changing the toggle, finishing a site for free. */
	static boolean gamemaster(CommandSourceStack src) {
		return src.permissions().hasPermission(net.minecraft.server.permissions.Permissions.COMMANDS_GAMEMASTER);
	}

	private static int survivalSet(CommandContext<CommandSourceStack> ctx, boolean on) {
		if (!gamemaster(ctx.getSource())) {
			ctx.getSource().sendFailure(Component.literal("Changing survival construction sites needs permission level 2 (cheats on, or an operator)"));
			return 0;
		}
		SurvivalWorld.set(ctx.getSource().getServer(), on);
		ctx.getSource().sendSuccess(() -> Component.literal("Survival construction sites turned " + (on ? "on" : "off") + " for this world"
			+ (on ? "" : " (construction sites already placed keep building)")), true);
		return 1;
	}

	private static int finish(CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack src = ctx.getSource();
		String id = StringArgumentType.getString(ctx, "site");
		ServerPlayer player = src.getPlayer();
		if (!gamemaster(src)) {
			src.sendFailure(Component.literal("/architect site finish needs permission level 2 (cheats on, or an operator)"));
			return 0;
		}
		if (player != null && !player.isCreative()) {
			src.sendFailure(Component.literal("/architect site finish is for a player in creative mode (it builds for free)"));
			return 0;
		}
		try {
			int n = Builder.finish(src.getServer(), id);
			src.sendSuccess(() -> Component.literal("Finished " + id + ": " + n + " cells placed free (a deconstruct refunds nothing for them)"), true);
			return 1;
		} catch (Sites.SiteException e) {
			src.sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
	}

	private static int siteState(CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack src = ctx.getSource();
		String id = StringArgumentType.getString(ctx, "site");
		try {
			com.google.gson.JsonObject o = Builder.state(src.getServer(), id);
			String head = id + " (" + (o.has("name") ? o.get("name").getAsString() : o.get("blueprint").getAsString()) + "): " + o.get("state").getAsString()
				+ (o.has("percent") ? ", " + o.get("percent").getAsInt() + "% (" + o.get("built").getAsInt() + "/" + o.get("queue").getAsInt() + " cells)" : "")
				+ (o.has("paused") && o.get("paused").getAsBoolean() ? ", paused" : "");
			src.sendSuccess(() -> Component.literal(head), false);
			if (o.has("rows")) {
				for (var e : o.getAsJsonArray("rows")) {
					var r = e.getAsJsonObject();
					if (r.get("missing").getAsInt() > 0) {
						src.sendSuccess(() -> Component.literal("  needs " + r.get("missing").getAsInt() + " " + r.get("name").getAsString()), false);
					}
				}
			}
			return 1;
		} catch (Sites.SiteException e) {
			src.sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
	}

	private static int open(CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack src = ctx.getSource();
		Consumer<ServerPlayer> opener = screenOpener;
		ServerPlayer player = src.getPlayer();
		if (opener == null || player == null || !src.getServer().isSingleplayerOwner(player.nameAndId())) {
			src.sendFailure(Component.literal("The Architect screen runs in singleplayer; here use /architect place <id> [rotation]"));
			return 0;
		}
		opener.accept(player);
		return 1;
	}

	private static int list(CommandContext<CommandSourceStack> ctx) {
		var all = Blueprints.entries();
		ctx.getSource().sendSuccess(() -> Component.literal(all.size() + " design(s) in the library" + (all.isEmpty()
			? " (yours: " + Blueprints.userDir() + ")" : ":")), false);
		for (Blueprints.Entry e : all) {
			Blueprint bp = e.blueprint();
			ctx.getSource().sendSuccess(() -> Component.literal(String.format(Locale.ROOT, "  %s  \"%s\"  %s  %dx%dx%d  front %s  [%s]", bp.id(),
				bp.name(), bp.type(), bp.sizeX(), bp.sizeY(), bp.sizeZ(), bp.front(), e.bundled() ? "bundled" : "yours")), false);
		}
		var sites = Sites.all();
		ctx.getSource().sendSuccess(() -> Component.literal(sites.size() + " site(s) in this world" + (sites.isEmpty() ? "" : ":")), false);
		for (Site b : sites) {
			ctx.getSource().sendSuccess(() -> Component.literal(String.format(Locale.ROOT, "  %s  %s  %s  box %s", b.id(), b.blueprint(), b.rotation(),
				Anchors.str(b.box()))), false);
			Sites.Report r = Sites.reports().get(b.id());
			if (r != null) {
				ctx.getSource().sendSuccess(() -> Component.literal("    " + (r.problem() ? "check: " : "note: ") + r.message()), false);
			}
		}
		return sites.size();
	}

	private static int place(CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack src = ctx.getSource();
		String bpId = StringArgumentType.getString(ctx, "id");
		Blueprint bp = Blueprints.get(bpId);
		if (bp == null) {
			src.sendFailure(Component.literal("Unknown design '" + bpId + "' (known: " + Blueprints.ids() + ")"));
			return 0;
		}
		String args;
		try {
			args = StringArgumentType.getString(ctx, "args").trim();
		} catch (IllegalArgumentException none) {
			args = "";
		}
		int turns = -1;
		boolean force = false;
		for (String t : args.isEmpty() ? new String[0] : args.split("\\s+")) {
			if (t.equalsIgnoreCase("force")) {
				force = true;
			} else if (t.equalsIgnoreCase("auto")) {
				turns = -1;
			} else if (BlueprintTransform.parseTurns(t) >= 0 && turns < 0) {
				turns = BlueprintTransform.parseTurns(t);
			} else {
				src.sendFailure(Component.literal("Unexpected '" + t + "': use /architect place <id> [none|clockwise_90|clockwise_180|counterclockwise_90] [force]"));
				return 0;
			}
		}
		Vec3 pos = src.getPosition();
		Direction facing = src.getEntity() != null ? src.getEntity().getDirection() : Direction.SOUTH;
		if (turns < 0) {
			turns = BlueprintTransform.turnsToFace(bp.front(), facing.getOpposite().getName()); // the entrance faces the player
		}
		int rsx = BlueprintTransform.rotatedSizeX(bp.sizeX(), bp.sizeZ(), turns);
		int rsz = BlueprintTransform.rotatedSizeZ(bp.sizeX(), bp.sizeZ(), turns);
		BlockPos feet = BlockPos.containing(pos);
		boolean facesPlayer = BlueprintTransform.rotateDirection(bp.front(), turns).equals(facing.getOpposite().getName());
		int gap = GAP + (facesPlayer ? bp.approach().length() : 0);
		int[] o = BlueprintTransform.originInFront(feet.getX(), feet.getY(), feet.getZ(), facing.getName(), rsx, rsz, bp.groundY(), gap);
		ServerLevel level = src.getLevel();
		try {
			ServerPlayer owner = src.getPlayer();
			Site b = Sites.place(level, bp, new BlockPos(o[0], o[1], o[2]), Rotation.values()[turns], force,
				owner == null ? null : owner.getUUID().toString());
			String note = Sites.lastNote();
			if (b.building()) {
				src.sendSuccess(() -> Component.literal("Construction site " + b.id() + " (" + bp.name() + ") placed: feed its crate (right-click it, or "
					+ "hoppers). Deconstruct: /architect remove " + b.id()), true);
				return 1;
			}
			src.sendSuccess(() -> Component.literal("Placed " + b.id() + " (" + bp.name() + "), " + b.rotation() + ", box " + Anchors.str(b.box())
				+ (note == null ? "" : " (" + note + ")") + ". Undo: /architect remove " + b.id()), true);
			return 1;
		} catch (Sites.SiteException e) {
			src.sendFailure(Component.literal(e.getMessage()));
			return 0;
		} catch (RuntimeException e) {
			Architect.LOGGER.error("Placing {} failed", bpId, e);
			src.sendFailure(Component.literal("Placing " + bpId + " failed: " + e));
			return 0;
		}
	}

	private static int remove(CommandContext<CommandSourceStack> ctx, boolean forgetOnly, boolean force) {
		CommandSourceStack src = ctx.getSource();
		String id = StringArgumentType.getString(ctx, "site");
		if (Sites.get(id) == null && Infras.get(id) != null) {
			return removeInfra(src, id, forgetOnly, force);
		}
		try {
			if (forgetOnly) {
				Sites.forget(src.getServer(), id);
				src.sendSuccess(() -> Component.literal("Forgot " + id + "; its blocks stay in the world"), true);
			} else if (Sites.removeLarge(src.getLevel(), id, force, Sites.Covered.KEEP) != null) {
				src.sendSuccess(() -> Component.literal("Removing " + id + " over ticks (a large site)"), true);
			} else {
				Site b = Sites.remove(src.getLevel(), id, force);
				src.sendSuccess(() -> Component.literal((b.construction() != null ? "Deconstructed " : "Removed ") + id + " (" + b.blueprint()
					+ "); restored " + Anchors.str(b.restoreBox()) + (b.construction() != null ? "; refunds and the crate's items dropped where the crate stood" : "")), true);
			}
			return 1;
		} catch (Sites.SiteException e) {
			src.sendFailure(Component.literal(e.getMessage()));
			return 0;
		} catch (RuntimeException e) {
			Architect.LOGGER.error("Removing {} failed", id, e);
			src.sendFailure(Component.literal("Removing " + id + " failed: " + e));
			return 0;
		}
	}

	// ------------------------------------------------------------------ phase 4e: roads, cell sites, the journal

	private static int removeInfra(CommandSourceStack src, String id, boolean forgetOnly, boolean both) {
		Infra i = Infras.get(id);
		if (forgetOnly) {
			try {
				String under = SiteJournal.below(id);
				if (under != null) {
					src.sendFailure(Component.literal(id + " lies on top of " + Sites.describe(under) + ": forget or remove the sites under it first"));
					return 0;
				}
				SiteJournal.await(SiteJournal.release(id), "forgetting " + id);
				Infras.drop(src.getServer(), id);
				src.sendSuccess(() -> Component.literal("Forgot " + i.describe() + "; its blocks stay in the world"), true);
				return 1;
			} catch (Sites.SiteException e) {
				src.sendFailure(Component.literal(e.getMessage()));
				return 0;
			}
		}
		try {
			InfraPlace.remove(src.getLevel(), id, both ? Sites.Covered.CASCADE : Sites.Covered.KEEP).whenComplete((r, e) -> src.getServer().execute(() -> {
				if (e != null) {
					src.sendFailure(Component.literal("Removing " + id + " failed: " + e.getMessage()));
				} else {
					src.sendSuccess(() -> Component.literal("Removed " + i.describe() + ": " + r.restored() + " cells restored" + (r.kept() > 0 ? ", " + r.kept()
						+ " you changed kept" : "") + (r.notes().isEmpty() ? "" : "; " + String.join("; ", r.notes()))), true);
				}
			}));
			src.sendSuccess(() -> Component.literal("Removing " + i.describe() + "..."), false);
			return 1;
		} catch (Sites.SiteException e) {
			src.sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
	}

	/** {@code /architect road <x z>... [width]}: waypoints, the ground under each the hint. */
	private static int road(CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack src = ctx.getSource();
		String[] parts = StringArgumentType.getString(ctx, "points").trim().split("\\s+");
		List<Integer> n = new java.util.ArrayList<>();
		try {
			for (String p : parts) {
				n.add(Integer.parseInt(p));
			}
		} catch (NumberFormatException e) {
			src.sendFailure(Component.literal("Usage: /architect road <x z> <x z> ... [width]"));
			return 0;
		}
		int width = 3;
		if (n.size() % 2 == 1) {
			width = n.remove(n.size() - 1);
		}
		if (n.size() < 4) {
			src.sendFailure(Component.literal("A road needs at least two waypoints: /architect road <x z> <x z> ... [width]"));
			return 0;
		}
		var level = src.getLevel();
		List<net.minecraft.core.BlockPos> pts = new java.util.ArrayList<>();
		for (int i = 0; i + 1 < n.size(); i += 2) {
			int x = n.get(i);
			int z = n.get(i + 1);
			int y = level.hasChunk(x >> 4, z >> 4) ? level.getHeight(net.minecraft.world.level.levelgen.Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1
				: (int) src.getPosition().y;
			pts.add(new net.minecraft.core.BlockPos(x, y, z));
		}
		String no = InfraPlace.modeRefusal(src.getServer(), dev.larattalabs.architect.api.Mode.INSTANT, src.getPlayer(), false);
		if (no != null) {
			src.sendFailure(Component.literal(no));
			return 0;
		}
		InfraPlace.Check c = InfraPlace.checkRoad(level, pts, width, null, null, false, false, null, false);
		if (!c.ok()) {
			src.sendFailure(Component.literal("No road: " + c.refusals().get(0).message()));
			return 0;
		}
		try {
			InfraJob job = InfraPlace.beginRoad(level, c, null, null, null);
			java.util.concurrent.CompletableFuture<dev.larattalabs.architect.api.PlaceResult> f = new java.util.concurrent.CompletableFuture<>();
			job.futures.add(f);
			Placement.add(src.getServer(), job);
			f.thenAccept(r -> src.sendSuccess(() -> Component.literal(r.placed() ? "Road " + job.siteId + " laid (" + c.cells() + " cells)"
				+ (c.notes().isEmpty() ? "" : "; " + String.join("; ", c.notes())) : "No road: " + r.refusals()), true));
			src.sendSuccess(() -> Component.literal("Laying road " + job.siteId + " (" + c.cells() + " cells)..."), false);
			return 1;
		} catch (Sites.SiteException e) {
			src.sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
	}

	/** {@code /architect journal}: the journal's entries and size. */
	private static int journal(CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack src = ctx.getSource();
		String why = dev.larattalabs.architect.journal.WorldJournal.unavailable();
		if (why != null) {
			src.sendFailure(Component.literal(why));
			return 0;
		}
		var s = dev.larattalabs.architect.journal.WorldJournal.storeOrNull();
		var idx = s.index();
		long active = idx.entries().values().stream().filter(dev.larattalabs.architect.journal.JournalStore.Meta::active).count();
		long cells = idx.entries().values().stream().mapToLong(dev.larattalabs.architect.journal.JournalStore.Meta::cells).sum();
		long bytes = s.bytesOnDisk();
		long warn = (long) dev.larattalabs.architect.survival.SurvivalWorld.journalWarnMb() << 20;
		src.sendSuccess(() -> Component.literal("World journal: " + idx.entries().size() + " entries (" + active + " standing), " + cells + " cells, "
			+ String.format(java.util.Locale.ROOT, "%.1f MB", bytes / 1048576.0) + " on disk" + (bytes > warn ? " (over the " + (warn >> 20)
				+ " MB warning)" : "") + "; cache " + dev.larattalabs.architect.survival.SurvivalWorld.journalCacheMb() + " MB"), false);
		return 1;
	}

	// ------------------------------------------------------------------ phase 5b: versions of placed sites

	private static java.util.concurrent.CompletableFuture<com.mojang.brigadier.suggestion.Suggestions> siteIds(CommandContext<CommandSourceStack> ctx,
		com.mojang.brigadier.suggestion.SuggestionsBuilder b) {
		Sites.all().forEach(x -> b.suggest(x.id()));
		return b.buildFuture();
	}

	/** {@code /architect site update <id> [version] [keep|overwrite]}: the delta to that version (the head by default). */
	private static int update(CommandContext<CommandSourceStack> ctx, int version, String edits) {
		CommandSourceStack src = ctx.getSource();
		String id = StringArgumentType.getString(ctx, "site");
		Site b = Sites.get(id);
		ServerLevel level = b == null ? null : Sites.levelOf(src.getServer(), b);
		if (level == null) {
			src.sendFailure(Component.literal(b == null ? "No site " + id + " (see /architect list)" : id + "'s dimension is not loaded"));
			return 0;
		}
		ServerPlayer player = src.getPlayer();
		boolean instant = !SurvivalWorld.on() || dev.larattalabs.architect.apiimpl.ApiRules.permission2(player);
		SiteDeltas.Request r = new SiteDeltas.Request(id, version, dev.larattalabs.architect.delta.DeltaPlanner.Edits.valueOf(edits.toUpperCase(Locale.ROOT)),
			false, b.owner(), true);
		try {
			SiteDeltas.Result res = instant ? SiteDeltas.apply(level, r) : Builder.applyConstructionDelta(level, r, player);
			String kept = res.kept().isEmpty() ? "" : "; kept " + res.kept().size() + " cell(s) you changed (" + SiteDeltas.describeKept(res.kept()) + ")";
			src.sendSuccess(() -> Component.literal("Updated " + id + " v" + res.from() + " -> v" + res.to() + ": " + res.written() + " cells written"
				+ (instant ? "" : " (a construction site: feed its crate)") + kept + (res.notes().isEmpty() ? "" : "; " + String.join("; ", res.notes()))),
				true);
			return 1;
		} catch (Sites.SiteException e) {
			src.sendFailure(Component.literal("Not updated: " + e.getMessage()));
			return 0;
		}
	}

	/** {@code /architect site revert <id> <version>}: creative undoes the deltas above it; survival rebuilds it (paid). */
	private static int revert(CommandContext<CommandSourceStack> ctx, int version) {
		CommandSourceStack src = ctx.getSource();
		String id = StringArgumentType.getString(ctx, "site");
		Site b = Sites.get(id);
		ServerLevel level = b == null ? null : Sites.levelOf(src.getServer(), b);
		if (level == null) {
			src.sendFailure(Component.literal(b == null ? "No site " + id : id + "'s dimension is not loaded"));
			return 0;
		}
		ServerPlayer player = src.getPlayer();
		boolean instant = !SurvivalWorld.on() || dev.larattalabs.architect.apiimpl.ApiRules.permission2(player);
		try {
			SiteDeltas.Result res = instant ? SiteDeltas.revert(level, id, version, b.owner(), true) : Builder.applyConstructionDelta(level,
				new SiteDeltas.Request(id, version, dev.larattalabs.architect.delta.DeltaPlanner.Edits.KEEP, false, b.owner(), true), player);
			src.sendSuccess(() -> Component.literal((instant ? "Reverted " : "Rebuilding ") + id + " to v" + res.to() + (res.notes().isEmpty() ? ""
				: ": " + String.join("; ", res.notes()))), true);
			return 1;
		} catch (Sites.SiteException e) {
			src.sendFailure(Component.literal("Not reverted: " + e.getMessage()));
			return 0;
		}
	}

	/** {@code /architect site history <id>}: the versions it stood at, and what an update would reach. */
	private static int history(CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack src = ctx.getSource();
		String id = StringArgumentType.getString(ctx, "site");
		Site b = Sites.get(id);
		if (b == null) {
			src.sendFailure(Component.literal("No site " + id));
			return 0;
		}
		int v = SiteDeltas.versionOf(src.getServer(), b);
		int head = SiteDeltas.headVersion(b.blueprint());
		src.sendSuccess(() -> Component.literal(id + " (" + b.blueprint() + ") stands at v" + v + (head > v ? "; v" + head + " available" : "")), false);
		for (Site.History h : SiteDeltas.history(src.getServer(), id)) {
			src.sendSuccess(() -> Component.literal("  v" + h.version() + " " + h.kind() + (h.revertible() ? "" : " (not undoable)") + " " + java.time.Instant
				.ofEpochMilli(h.appliedAt())), false);
		}
		return 1;
	}
}
