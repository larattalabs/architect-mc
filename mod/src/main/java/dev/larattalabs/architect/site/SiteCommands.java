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
 * </pre>
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
					.then(Commands.literal("force").executes(ctx -> remove(ctx, false, true)))))));
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
			Site b = Sites.place(level, bp, new BlockPos(o[0], o[1], o[2]), Rotation.values()[turns], force);
			String note = Sites.lastNote();
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
		try {
			if (forgetOnly) {
				Sites.forget(src.getServer(), id);
				src.sendSuccess(() -> Component.literal("Forgot " + id + "; its blocks stay in the world"), true);
			} else {
				Site b = Sites.remove(src.getLevel(), id, force);
				src.sendSuccess(() -> Component.literal("Removed " + id + " (" + b.blueprint() + "); restored " + Anchors.str(b.restoreBox())), true);
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
}
