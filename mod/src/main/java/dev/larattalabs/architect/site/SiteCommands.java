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
 * /architect reload                 reload the library (bundled + yours): the count, and [show] for the problems
 * /architect reload problems [page] [filter]
 *                                   the last reload's problems, paged
 * /architect list [page] [filter]   the library's designs and this world's sites, paged (8 a page, [‹ prev] [next ›])
 * /architect library [site]         open the Library on this world's sites (singleplayer), the site selected
 * /architect survival [on|off]      show / change this world's survival toggle (changing it needs permission level 2)
 * /architect site finish &lt;site&gt;     build a construction site's remaining cells at once, free (permission 2, creative mode)
 * /architect site state &lt;site&gt;      a construction site's progress and what it still needs
 * /architect batches [page] [filter]
 *                                   the placement batches of this world (phase 4d), paged
 * /architect batch cancel &lt;batch&gt;   cancel a batch: placed items stay, the one placing rolls back, the rest are dropped
 * /architect groups [page] [filter]  the site groups (their stages and sites as hover text), paged
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
	/** Opens the Library on the placed sites with a site selected (null = none); installed by the client like {@link #screenOpener}. */
	public static volatile java.util.function.@Nullable BiConsumer<ServerPlayer, @Nullable String> libraryOpener;

	private SiteCommands() {
	}

	public static void init() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registry, env) -> dispatcher.register(Commands.literal("architect")
			.executes(SiteCommands::open)
			.then(Commands.literal("list").executes(SiteCommands::list).then(Commands.argument(ChatLists.ARG, StringArgumentType.greedyString()).executes(SiteCommands::list)))
			.then(Commands.literal("reload").executes(SiteCommands::reload)
				.then(Commands.literal("problems").executes(SiteCommands::reloadProblems).then(Commands.argument(ChatLists.ARG, StringArgumentType.greedyString()).executes(SiteCommands::reloadProblems))))
			.then(Commands.literal("library").executes(ctx -> library(ctx, null))
				.then(Commands.argument("site", StringArgumentType.word()).suggests(SiteCommands::siteIds)
					.executes(ctx -> library(ctx, StringArgumentType.getString(ctx, "site")))))
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
					.then(Commands.argument("site", StringArgumentType.word()).suggests(SiteCommands::siteIds).executes(SiteCommands::history)
						.then(Commands.argument(ChatLists.ARG, StringArgumentType.greedyString()).executes(SiteCommands::history)))))
			.then(Commands.literal("batches").executes(SiteCommands::batches).then(Commands.argument(ChatLists.ARG, StringArgumentType.greedyString()).executes(SiteCommands::batches)))
			.then(Commands.literal("batch")
				.then(Commands.literal("cancel")
					.then(Commands.argument("batch", StringArgumentType.word()).suggests((ctx, b) -> {
						Batches.all().stream().filter(x -> x.running()).forEach(x -> b.suggest(x.id));
						return b.buildFuture();
					}).executes(SiteCommands::batchCancel))))
			.then(Commands.literal("groups").executes(SiteCommands::groups).then(Commands.argument(ChatLists.ARG, StringArgumentType.greedyString()).executes(SiteCommands::groups)))
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
			.then(Commands.literal("stockpile") // 6c Y1 (C24)
				.then(Commands.literal("list").executes(SiteCommands::stockpiles).then(Commands.argument(ChatLists.ARG, StringArgumentType.greedyString()).executes(SiteCommands::stockpiles)))
				.then(Commands.literal("removecrate")
					.then(Commands.argument("pos", net.minecraft.commands.arguments.coordinates.BlockPosArgument.blockPos())
						.executes(ctx -> removeCrate(ctx, false))
						.then(Commands.literal("force").executes(ctx -> removeCrate(ctx, true))))))
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
		List<Component> lines = new java.util.ArrayList<>();
		for (dev.larattalabs.architect.batch.QBatch b : all) {
			long placed = b.items.stream().filter(i -> i.status == dev.larattalabs.architect.batch.QItem.Status.PLACED).count();
			long failed = b.items.stream().filter(i -> i.status == dev.larattalabs.architect.batch.QItem.Status.FAILED).count();
			long waiting = b.items.stream().filter(i -> i.status == dev.larattalabs.architect.batch.QItem.Status.WAITING).count();
			lines.add(Component.literal(b.id + " (group " + b.group + "): " + b.status.name().toLowerCase(Locale.ROOT) + ", "
				+ placed + "/" + b.items.size() + " placed" + (failed > 0 ? ", " + failed + " failed" : "") + (waiting > 0 ? ", " + waiting + " waiting" : "")
				+ (b.note.isEmpty() ? "" : " (" + b.note + ")")));
		}
		ctx.getSource().sendSuccess(() -> Component.literal(all.size() + " placement batch" + (all.size() == 1 ? "" : "es") + " in this world:"), false);
		ChatLists.send(ctx.getSource(), lines, ChatLists.args(ctx), "/architect batches");
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
		List<Component> lines = new java.util.ArrayList<>();
		for (SiteGroupRec g : all) {
			// one short line a group; the stage list and the site ids are its hover text (a long group no longer floods chat)
			StringBuilder st = new StringBuilder();
			java.util.Map<String, Integer> byState = new java.util.LinkedHashMap<>();
			for (SiteGroupRec.StageRec x : g.stages()) {
				String state = x.state().name().toLowerCase(Locale.ROOT);
				st.append(st.isEmpty() ? "" : "\n").append(x.name()).append(": ").append(state);
				byState.merge(state, 1, Integer::sum);
			}
			StringBuilder counts = new StringBuilder();
			byState.forEach((k, n) -> counts.append(counts.isEmpty() ? "" : ", ").append(n).append(" ").append(k));
			String hover = "Sites: " + String.join(", ", g.sites()) + (st.isEmpty() ? "" : "\nStages:\n" + st);
			lines.add(Component.literal(g.id() + (g.owner() == null ? "" : " (owned by " + g.owner() + ")") + ": " + g.state().toString().toLowerCase(Locale.ROOT)
				+ ", " + g.sites().size() + " site" + (g.sites().size() == 1 ? "" : "s") + (counts.isEmpty() ? "" : "; stages " + counts))
				.withStyle(x -> x.withHoverEvent(new net.minecraft.network.chat.HoverEvent.ShowText(Component.literal(hover)))));
		}
		ctx.getSource().sendSuccess(() -> Component.literal(all.size() + " site group" + (all.size() == 1 ? "" : "s") + " in this world (hover a line for its "
			+ "stages):"), false);
		ChatLists.send(ctx.getSource(), lines, ChatLists.args(ctx), "/architect groups");
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

	// ------------------------------------------------------------------ 6c Y1: stockpiles

	private static int stockpiles(CommandContext<CommandSourceStack> ctx) {
		var all = Stockpiles.all();
		if (all.isEmpty()) {
			ctx.getSource().sendSuccess(() -> Component.literal("No stockpiles in this world"), false);
			return 0;
		}
		List<Component> lines = new java.util.ArrayList<>();
		for (Stockpiles.Pile p : all) {
			String stock = String.valueOf(p.ledger().stock());
			lines.add(Component.literal(p.owner() + ": " + p.crates().size() + " crate" + (p.crates().size() == 1 ? "" : "s") + " in " + p.dimension()
				+ ", feeds " + p.order().size() + " site" + (p.order().size() == 1 ? "" : "s") + " (hover for the stock)")
				.withStyle(x -> x.withHoverEvent(new net.minecraft.network.chat.HoverEvent.ShowText(Component.literal("Stock: " + stock + "\nFeed order: "
					+ p.order())))));
		}
		ctx.getSource().sendSuccess(() -> Component.literal(all.size() + " stockpile" + (all.size() == 1 ? "" : "s") + " in this world:"), false);
		ChatLists.send(ctx.getSource(), lines, ChatLists.args(ctx), "/architect stockpile list");
		return all.size();
	}

	/** {@code /architect stockpile removecrate <pos> [force]} (permission level 2). */
	private static int removeCrate(CommandContext<CommandSourceStack> ctx, boolean force) {
		CommandSourceStack src = ctx.getSource();
		if (!gamemaster(src)) {
			src.sendFailure(Component.literal("Removing a stockpile crate needs permission level 2 (cheats on, or an operator)"));
			return 0;
		}
		net.minecraft.core.BlockPos pos = net.minecraft.commands.arguments.coordinates.BlockPosArgument.getBlockPos(ctx, "pos");
		Stockpiles.Pile pile = Stockpiles.all().stream().filter(p -> p.crates().contains(pos)).findFirst().orElse(null);
		if (pile == null) {
			src.sendFailure(Component.literal(pos.toShortString() + " is not a stockpile crate"));
			return 0;
		}
		try {
			Stockpiles.CrateRemoval r = Stockpiles.removeCrate(src.getServer(), pile.owner(), pos, force);
			if (!r.removed()) {
				src.sendFailure(Component.literal("Not removed: " + r.refusal()));
				return 0;
			}
			src.sendSuccess(() -> Component.literal("Removed the crate at " + pos.toShortString() + " of " + pile.owner() + (r.dropped().isEmpty() ? ""
				: "; dropped the excess " + r.dropped()) + (r.ended() ? "; the stockpile ended" : "")), true);
			return 1;
		} catch (Sites.SiteException e) {
			src.sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
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

	/**
	 * {@code /architect list [page] [filter]}: the library's designs and this world's sites, one line each, paged ({@link ChatLists}).
	 * A site's check or note is its line's hover text (marked "· check" / "· note"), so a page break or the filter never separates
	 * them. Click a design to put {@code /architect place <id>} in the chat box.
	 */
	private static int list(CommandContext<CommandSourceStack> ctx) {
		var all = Blueprints.entries();
		var sites = Sites.all();
		List<Component> lines = new java.util.ArrayList<>();
		for (Blueprints.Entry e : all) {
			Blueprint bp = e.blueprint();
			lines.add(Component.literal(String.format(Locale.ROOT, "design %s \"%s\" %s %dx%dx%d [%s]", bp.id(), bp.name(), bp.type(), bp.sizeX(),
				bp.sizeY(), bp.sizeZ(), e.bundled() ? "bundled" : "yours")).withStyle(x -> x
				.withClickEvent(new net.minecraft.network.chat.ClickEvent.SuggestCommand("/architect place " + bp.id()))
				.withHoverEvent(new net.minecraft.network.chat.HoverEvent.ShowText(Component.literal("Entrance faces " + bp.front()
					+ "\nClick: /architect place " + bp.id())))));
		}
		for (Site b : sites) {
			Sites.Report r = Sites.reports().get(b.id());
			String text = String.format(Locale.ROOT, "site %s (%s) %s at %s", b.id(), b.blueprint(), b.rotation().replace('_', ' ').toLowerCase(Locale.ROOT),
				b.box().minX() + " " + b.box().minY() + " " + b.box().minZ()) + (r == null ? "" : r.problem() ? " · check" : " · note");
			String hover = "Box " + Anchors.str(b.box()) + (r == null ? "" : "\n" + (r.problem() ? "Check: " : "Note: ") + r.message());
			lines.add(Component.literal(text).withStyle(x -> {
				var st = x.withHoverEvent(new net.minecraft.network.chat.HoverEvent.ShowText(Component.literal(hover)));
				return r != null && r.problem() ? st.withColor(net.minecraft.ChatFormatting.GOLD) : st;
			}));
		}
		ctx.getSource().sendSuccess(() -> Component.literal(all.size() + " design" + (all.size() == 1 ? "" : "s") + " in the library, " + sites.size()
			+ " site" + (sites.size() == 1 ? "" : "s") + " in this world" + (all.isEmpty() ? " (your designs go in " + Blueprints.userDir() + ")" : ":")), false);
		if (!lines.isEmpty()) {
			ChatLists.send(ctx.getSource(), lines, ChatLists.args(ctx), "/architect list");
		}
		return sites.size();
	}

	/** {@code /architect reload}: the count, and a link to the problems (they no longer flood chat). */
	private static int reload(CommandContext<CommandSourceStack> ctx) {
		Blueprints.reload(ctx.getSource().getServer());
		List<String> problems = Blueprints.lastProblems();
		int n = Blueprints.ids().size();
		net.minecraft.network.chat.MutableComponent m = Component.literal("Reloaded " + n + " design" + (n == 1 ? "" : "s"));
		if (!problems.isEmpty()) {
			m.append("; skipped " + problems.size() + " with problems ").append(Component.literal("[show]").withStyle(x -> x
				.withColor(net.minecraft.ChatFormatting.AQUA).withUnderlined(true)
				.withClickEvent(new net.minecraft.network.chat.ClickEvent.RunCommand("/architect reload problems"))
				.withHoverEvent(new net.minecraft.network.chat.HoverEvent.ShowText(Component.literal("/architect reload problems")))));
		}
		ctx.getSource().sendSuccess(() -> m, false);
		return n;
	}

	/** {@code /architect reload problems [page] [filter]}: the last reload's problems, paged (it does not reload again). */
	private static int reloadProblems(CommandContext<CommandSourceStack> ctx) {
		List<String> problems = Blueprints.lastProblems();
		if (problems.isEmpty()) {
			ctx.getSource().sendSuccess(() -> Component.literal("The last reload had no problems"), false);
			return 0;
		}
		List<Component> lines = new java.util.ArrayList<>();
		for (String p : problems) {
			lines.add(Component.literal(p).withStyle(net.minecraft.ChatFormatting.GOLD));
		}
		ctx.getSource().sendSuccess(() -> Component.literal(problems.size() + " design" + (problems.size() == 1 ? "" : "s") + " skipped at the last reload:"),
			false);
		ChatLists.send(ctx.getSource(), lines, ChatLists.args(ctx), "/architect reload problems");
		return problems.size();
	}

	/**
	 * Opens the Library screen on this world's placed sites, with {@code site} selected (the "Placed" chat line's [Open in Library]
	 * link). Singleplayer only, like the screen.
	 */
	private static int library(CommandContext<CommandSourceStack> ctx, @Nullable String site) {
		CommandSourceStack src = ctx.getSource();
		java.util.function.BiConsumer<ServerPlayer, String> opener = libraryOpener;
		ServerPlayer player = src.getPlayer();
		if (opener == null || player == null || !src.getServer().isSingleplayerOwner(player.nameAndId())) {
			src.sendFailure(Component.literal("The Library screen runs in singleplayer; here use /architect list"));
			return 0;
		}
		if (site != null && Sites.get(site) == null) {
			src.sendFailure(Component.literal("No site " + site + " (see /architect list)"));
			return 0;
		}
		opener.accept(player, site);
		return 1;
	}

	/** "Unknown design 'x'. Did you mean [a], [b]? See [/architect list]": each a click that puts its place command in the chat box. */
	static Component unknownDesign(String id) {
		List<String> close = DidYouMean.suggest(id, Blueprints.ids(), DidYouMean.MAX);
		net.minecraft.network.chat.MutableComponent m = Component.literal("Unknown design '" + id + "'.");
		if (!close.isEmpty()) {
			m.append(" Did you mean ");
			for (int i = 0; i < close.size(); i++) {
				String c = close.get(i);
				m.append(i == 0 ? "" : ", ").append(Component.literal(c).withStyle(x -> x.withUnderlined(true)
					.withClickEvent(new net.minecraft.network.chat.ClickEvent.SuggestCommand("/architect place " + c))
					.withHoverEvent(new net.minecraft.network.chat.HoverEvent.ShowText(Component.literal("/architect place " + c)))));
			}
			m.append("?");
		}
		return m.append(" See ").append(Component.literal("/architect list").withStyle(x -> x.withUnderlined(true)
			.withClickEvent(new net.minecraft.network.chat.ClickEvent.RunCommand("/architect list")))).append(".");
	}

	private static int place(CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack src = ctx.getSource();
		String bpId = StringArgumentType.getString(ctx, "id");
		Blueprint bp = Blueprints.get(bpId);
		if (bp == null) {
			src.sendFailure(unknownDesign(bpId));
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
		List<Component> lines = new java.util.ArrayList<>();
		for (Site.History h : SiteDeltas.history(src.getServer(), id)) {
			lines.add(Component.literal("v" + h.version() + " " + h.kind() + (h.revertible() ? "" : " (not undoable)") + " " + java.time.Instant
				.ofEpochMilli(h.appliedAt())));
		}
		if (!lines.isEmpty()) {
			ChatLists.send(src, lines, ChatLists.args(ctx), "/architect site history " + id);
		}
		return 1;
	}
}
