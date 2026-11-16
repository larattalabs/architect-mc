package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.ArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import dev.larattalabs.architect.api.DiagnoseScope;
import dev.larattalabs.architect.api.Diagnosis;
import dev.larattalabs.architect.api.RepairFinding;
import dev.larattalabs.architect.api.RepairResult;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/**
 * (DR) {@code /architect diagnose <site <id>|region <id>|here|all>}, {@code /architect repair <scope> [confirm <planId>]} and
 * {@code /architect repair log [planId]}: ops only (gamemaster permission, as SiteCommands' changes). A repair without {@code confirm}
 * is a dry run; one over {@link Repairs#LARGE} cells asks SAFETY's confirm (the same command again within 30 s).
 */
final class RepairCommands {
	private RepairCommands() {
	}

	private static final Map<UUID, String> LARGE_ASKED = new HashMap<>();
	private static final Map<UUID, Long> LARGE_AT = new HashMap<>();

	static void init() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registry, env) -> {
			var diagnose = Commands.literal("diagnose").requires(RepairCommands::ops);
			scopes(diagnose, s -> ctx -> diagnose(ctx, s.apply(ctx)));
			var repair = Commands.literal("repair").requires(RepairCommands::ops);
			repair.then(Commands.literal("log").executes(ctx -> log(ctx, null)).then(Commands.argument("planId", StringArgumentType.word()).executes(
				ctx -> log(ctx, StringArgumentType.getString(ctx, "planId")))));
			scopesWithConfirm(repair);
			dispatcher.register(Commands.literal("architect").then(diagnose).then(repair));
		});
	}

	static boolean ops(CommandSourceStack src) {
		return src.permissions().hasPermission(net.minecraft.server.permissions.Permissions.COMMANDS_GAMEMASTER);
	}

	interface Run {
		int run(CommandContext<CommandSourceStack> ctx) throws com.mojang.brigadier.exceptions.CommandSyntaxException;
	}

	private static void scopes(ArgumentBuilder<CommandSourceStack, ?> node, Function<Function<CommandContext<CommandSourceStack>, DiagnoseScope>, Run> exec) {
		node.then(Commands.literal("site").then(Commands.argument("id", StringArgumentType.word()).executes(exec.apply(c -> DiagnoseScope.site(
			StringArgumentType.getString(c, "id")))::run)));
		node.then(Commands.literal("region").then(Commands.argument("id", StringArgumentType.word()).executes(exec.apply(c -> DiagnoseScope.region(
			StringArgumentType.getString(c, "id")))::run)));
		node.then(Commands.literal("here").executes(exec.apply(RepairCommands::here)::run));
		node.then(Commands.literal("all").executes(exec.apply(c -> DiagnoseScope.all())::run));
	}

	private static DiagnoseScope here(CommandContext<CommandSourceStack> c) {
		var src = c.getSource();
		return DiagnoseScope.here(src.getLevel().dimension(), net.minecraft.core.BlockPos.containing(src.getPosition()));
	}

	private static void scopesWithConfirm(ArgumentBuilder<CommandSourceStack, ?> node) {
		Function<Function<CommandContext<CommandSourceStack>, DiagnoseScope>, ArgumentBuilder<CommandSourceStack, ?>> confirm = s -> Commands.literal(
			"confirm").then(Commands.argument("planId", StringArgumentType.word()).executes(ctx -> repair(ctx, s.apply(ctx), StringArgumentType
				.getString(ctx, "planId"))));
		Function<CommandContext<CommandSourceStack>, DiagnoseScope> site = c -> DiagnoseScope.site(StringArgumentType.getString(c, "id"));
		Function<CommandContext<CommandSourceStack>, DiagnoseScope> region = c -> DiagnoseScope.region(StringArgumentType.getString(c, "id"));
		Function<CommandContext<CommandSourceStack>, DiagnoseScope> all = c -> DiagnoseScope.all();
		node.then(Commands.literal("site").then(Commands.argument("id", StringArgumentType.word()).executes(ctx -> repair(ctx, site.apply(ctx), null))
			.then(confirm.apply(site))));
		node.then(Commands.literal("region").then(Commands.argument("id", StringArgumentType.word()).executes(ctx -> repair(ctx, region.apply(ctx),
			null)).then(confirm.apply(region))));
		node.then(Commands.literal("here").executes(ctx -> repair(ctx, here(ctx), null)).then(confirm.apply(RepairCommands::here)));
		node.then(Commands.literal("all").executes(ctx -> repair(ctx, all.apply(ctx), null)).then(confirm.apply(all)));
	}

	private static int diagnose(CommandContext<CommandSourceStack> ctx, DiagnoseScope scope) {
		var src = ctx.getSource();
		if (!Repairs.startDone()) {
			src.sendFailure(Component.literal("The world is still starting; diagnose again in a moment"));
			return 0;
		}
		Diagnosis d = Repairs.diagnose(src.getServer(), scope);
		if (d.findings().isEmpty()) {
			src.sendSuccess(() -> Component.literal("Nothing lags the journal in " + scope.describe() + "."), false);
			return 1;
		}
		src.sendSuccess(() -> Component.literal(d.findings().size() + " finding(s) in " + scope.describe() + " (plan " + d.planId() + "):"), false);
		int n = 0;
		for (RepairFinding f : d.findings()) {
			if (n++ >= 12) {
				src.sendSuccess(() -> Component.literal("... and " + (d.findings().size() - 12) + " more"), false);
				break;
			}
			src.sendSuccess(() -> Component.literal(" " + f.code() + ": " + f.message()), false);
		}
		src.sendSuccess(() -> Component.literal("/architect repair " + scope.describe() + " shows what a repair would write (a dry run)."), false);
		return 1;
	}

	private static int repair(CommandContext<CommandSourceStack> ctx, DiagnoseScope scope, @Nullable String planId) {
		var src = ctx.getSource();
		ServerPlayer p = src.getPlayer();
		if (p == null) {
			src.sendFailure(Component.literal("A repair needs an operator player as its actor (it is recorded in the repair record)"));
			return 0;
		}
		if (!Repairs.startDone()) {
			src.sendFailure(Component.literal("The world is still starting; try again in a moment"));
			return 0;
		}
		if (planId == null) {
			Diagnosis d = Repairs.diagnose(src.getServer(), scope);
			RepairResult r = Repairs.repair(src.getServer(), d.planId(), p, false);
			say(src, r);
			return r.refused() == null ? 1 : 0;
		}
		RepairResult dry = Repairs.repair(src.getServer(), planId, p, false);
		if (dry.refused() != null) {
			say(src, dry);
			return 0;
		}
		if (dry.written() > Repairs.LARGE) {
			Long at = LARGE_AT.get(p.getUUID());
			if (!planId.equals(LARGE_ASKED.get(p.getUUID())) || at == null || System.currentTimeMillis() - at > 30_000) {
				LARGE_ASKED.put(p.getUUID(), planId);
				LARGE_AT.put(p.getUUID(), System.currentTimeMillis());
				src.sendSuccess(() -> Component.literal(String.format(java.util.Locale.ROOT, "This repair writes %,d cells (over %,d). Run the same "
					+ "command again within 30 s to confirm.", dry.written(), Repairs.LARGE)), false);
				return 1;
			}
			LARGE_ASKED.remove(p.getUUID());
		}
		RepairResult r = Repairs.repair(src.getServer(), planId, p, true);
		say(src, r);
		return r.refused() == null ? 1 : 0;
	}

	private static void say(CommandSourceStack src, RepairResult r) {
		if (r.refused() != null) {
			src.sendFailure(Component.literal(r.refused() + ": " + r.message()));
		} else {
			src.sendSuccess(() -> Component.literal(r.message()), false);
		}
	}

	private static int log(CommandContext<CommandSourceStack> ctx, @Nullable String planId) {
		var src = ctx.getSource();
		var recs = Repairs.records(planId);
		if (recs.isEmpty()) {
			src.sendSuccess(() -> Component.literal(planId == null ? "No repairs in this world." : "No repair " + planId + "."), false);
			return 1;
		}
		int n = 0;
		for (JsonObject o : recs) {
			if (n++ >= 10) {
				break;
			}
			String line = o.get("planId").getAsString() + " " + o.get("state").getAsString() + " by " + o.get("op").getAsString() + ": " + o.get("scope")
				.getAsString() + ", wrote " + (o.has("written") ? o.get("written").getAsInt() : 0) + ", left " + (o.has("left") ? o.get("left").getAsInt()
					: 0) + (o.has("credited") && o.getAsJsonObject("credited").size() > 0 ? ", credited " + o.getAsJsonObject("credited") : "");
			src.sendSuccess(() -> Component.literal(line), false);
		}
		return 1;
	}
}
