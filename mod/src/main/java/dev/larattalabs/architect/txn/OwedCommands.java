package dev.larattalabs.architect.txn;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.site.OwedLedger;
import java.util.List;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.EntityArgument;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/**
 * (slice T2b) {@code /architect collect}: every player collects what is owed to their own UUID, oldest first ({@code /architect collect}),
 * or one entry ({@code /architect collect <key>}). Only what fits in the inventory is given; the rest stays owed (nothing drops, nothing
 * goes to a crate). Ops (gamemaster) may collect any entry, a settlement's included, to a named player: {@code /architect collect <key>
 * <player>}, logged. Each collect is an {@code owed.collect} txn ({@link OwedTxn}).
 */
public final class OwedCommands {
	private OwedCommands() {
	}

	static void init() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registry, env) -> dispatcher.register(Commands.literal("architect").then(Commands.literal(
			"collect").executes(OwedCommands::all).then(Commands.argument("key", StringArgumentType.string()).executes(ctx -> one(ctx, null)).then(
				Commands.argument("player", EntityArgument.player()).requires(OwedCommands::ops).executes(ctx -> one(ctx, EntityArgument.getPlayer(ctx,
					"player"))))))));
		// (slice T4R-D, Q7) /architect owed nearby: the unclaimed player blocks within 64 blocks (any player may collect them by key)
		CommandRegistrationCallback.EVENT.register((dispatcher, registry, env) -> dispatcher.register(Commands.literal("architect").then(Commands.literal(
			"owed").then(Commands.literal("nearby").executes(OwedCommands::nearby)))));
	}

	/** (slice T4R-D, Q7) The {@code architect:unclaimed} entries within 64 blocks of the caller, in its dimension. */
	static int nearby(CommandContext<CommandSourceStack> ctx) throws com.mojang.brigadier.exceptions.CommandSyntaxException {
		ServerPlayer p = ctx.getSource().getPlayerOrException();
		String dim = p.level().dimension().identifier().toString();
		int n = 0;
		for (OwedLedger.Entry e : OwedLedger.of(OwedLedger.UNCLAIMED)) {
			if (!e.dimension().equals(dim) || p.blockPosition().distSqr(new net.minecraft.core.BlockPos(e.x(), e.y(), e.z())) > 64 * 64) {
				continue;
			}
			n++;
			int c = e.items().values().stream().mapToInt(Integer::intValue).sum();
			ctx.getSource().sendSuccess(() -> Component.literal("Unclaimed: " + c + " item(s) at " + e.x() + " " + e.y() + " " + e.z() + ": /architect collect "
				+ e.key()), false);
		}
		if (n == 0) {
			ctx.getSource().sendSuccess(() -> Component.literal("No unclaimed blocks within 64 blocks."), false);
		}
		return n;
	}

	static boolean ops(CommandSourceStack src) {
		return src.permissions().hasPermission(net.minecraft.server.permissions.Permissions.COMMANDS_GAMEMASTER);
	}

	static int all(CommandContext<CommandSourceStack> ctx) throws com.mojang.brigadier.exceptions.CommandSyntaxException {
		ServerPlayer p = ctx.getSource().getPlayerOrException();
		List<OwedLedger.Entry> es = OwedLedger.of(p.getUUID().toString());
		if (es.isEmpty()) {
			ctx.getSource().sendSuccess(() -> Component.literal("Nothing is owed to you."), false);
			return 0;
		}
		int n = 0;
		for (OwedLedger.Entry e : es) {
			n += report(ctx.getSource(), e.key(), OwedTxn.collect(ctx.getSource().getServer(), e.recipient(), e.key(), p));
		}
		return n;
	}

	static int one(CommandContext<CommandSourceStack> ctx, ServerPlayer to) throws com.mojang.brigadier.exceptions.CommandSyntaxException {
		String key = StringArgumentType.getString(ctx, "key");
		OwedLedger.Entry e = OwedLedger.get(key);
		ServerPlayer p = to != null ? to : ctx.getSource().getPlayerOrException();
		if (e == null) {
			ctx.getSource().sendFailure(Component.literal("Nothing is owed under " + key + "."));
			return 0;
		}
		// (slice T4R-D, Q7) an unclaimed entry is anyone's to collect (its per-entry collect lock kept: the txn's owed:<key> resource)
		boolean own = (e.recipient().equals(p.getUUID().toString()) || OwedLedger.UNCLAIMED.equals(e.recipient())) && to == null;
		if (!own && !ops(ctx.getSource())) {
			ctx.getSource().sendFailure(Component.literal(key + " is not owed to you."));
			return 0;
		}
		if (!own) {
			Architect.LOGGER.info("Owed: {} collects {} (owed to {}) for {}", ctx.getSource().getTextName(), key, e.recipient(), p.getGameProfile().name());
		}
		return report(ctx.getSource(), key, OwedTxn.collect(ctx.getSource().getServer(), e.recipient(), key, p));
	}

	static int report(CommandSourceStack src, String key, OwedTxn.Answer a) {
		int given = a.given().values().stream().mapToInt(Integer::intValue).sum();
		int left = a.stillOwed().values().stream().mapToInt(Integer::intValue).sum();
		switch (a.status()) {
			case "DONE" -> src.sendSuccess(() -> Component.literal("Collected " + given + " from " + key + (left > 0 ? "; still owed " + left
				+ (given == 0 || a.detail() != null ? " (inventory full)" : "") : "") + "."), false);
			case "HELD" -> src.sendSuccess(() -> Component.literal("Collecting " + key + " is under way (" + a.detail() + ")."), false);
			default -> src.sendFailure(Component.literal("Could not collect " + key + ": " + a.why()));
		}
		return given;
	}
}
