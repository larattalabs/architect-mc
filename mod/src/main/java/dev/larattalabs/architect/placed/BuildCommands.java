package dev.larattalabs.architect.placed;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.Build;
import java.lang.reflect.Field;
import java.util.Locale;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.coordinates.BlockPosArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * {@code /architect build} (docs/CONTRACT.md "Phase 6c slice PT" §8, §9):
 * <pre>
 * /architect build claim &lt;x0 y0 z0&gt; &lt;x1 y1 z1&gt;   marks the box's cells as yours, one CLAIMED build (pre-tracking builds)
 * /architect build release &lt;id&gt;                  a placer or an op: the build becomes RELEASED (incidental)
 * /architect build list                           the builds of this dimension
 * /architect build at &lt;x y z&gt;                     who placed a cell, and its build
 * /architect build rule [&lt;name&gt; [&lt;value&gt;]]       the world rules (op): playerTracking, promote, demote, ... (N-PT-3)
 * </pre>
 */
public final class BuildCommands {
	private BuildCommands() {
	}

	static void init() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registry, env) -> dispatcher.register(Commands.literal("architect").then(Commands.literal("build")
			.then(Commands.literal("claim").then(Commands.argument("from", BlockPosArgument.blockPos()).then(Commands.argument("to", BlockPosArgument.blockPos())
				.executes(BuildCommands::claim))))
			.then(Commands.literal("release").then(Commands.argument("id", StringArgumentType.word()).executes(BuildCommands::release)))
			.then(Commands.literal("list").executes(BuildCommands::list))
			.then(Commands.literal("at").then(Commands.argument("pos", BlockPosArgument.blockPos()).executes(BuildCommands::at)))
			.then(Commands.literal("rule").requires(BuildCommands::op).executes(c -> rule(c, null, null))
				.then(Commands.argument("name", StringArgumentType.word()).executes(c -> rule(c, StringArgumentType.getString(c, "name"), null))
					.then(Commands.argument("value", StringArgumentType.word()).executes(c -> rule(c, StringArgumentType.getString(c, "name"), StringArgumentType
						.getString(c, "value")))))))));
	}

	static boolean op(CommandSourceStack s) {
		return s.permissions().hasPermission(net.minecraft.server.permissions.Permissions.COMMANDS_GAMEMASTER);
	}

	private static int claim(CommandContext<CommandSourceStack> c) {
		CommandSourceStack src = c.getSource();
		try {
			BlockPos a = BlockPosArgument.getLoadedBlockPos(c, "from");
			BlockPos b = BlockPosArgument.getLoadedBlockPos(c, "to");
			ServerPlayer p = src.getPlayer();
			Build bd = BuildViews.claim(src.getLevel(), BoundingBox.fromCorners(a, b), p, p == null);
			src.sendSuccess(() -> Component.literal("Claimed " + bd.id() + ": " + bd.cells() + " cells (" + bd.kind().name().toLowerCase(Locale.ROOT) + ")"),
				false);
			return 1;
		} catch (ArchitectRefused e) {
			src.sendFailure(Component.literal(e.getMessage()));
			return 0;
		} catch (com.mojang.brigadier.exceptions.CommandSyntaxException e) {
			src.sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
	}

	private static int release(CommandContext<CommandSourceStack> c) {
		CommandSourceStack src = c.getSource();
		try {
			ServerPlayer p = src.getPlayer();
			Build bd = BuildViews.release(StringArgumentType.getString(c, "id"), p, p == null);
			src.sendSuccess(() -> Component.literal("Released " + bd.id() + " (" + bd.cells() + " cells stay tracked, incidental)"), false);
			return 1;
		} catch (ArchitectRefused e) {
			src.sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
	}

	private static int list(CommandContext<CommandSourceStack> c) {
		CommandSourceStack src = c.getSource();
		var all = BuildViews.builds(src.getLevel().dimension(), null);
		src.sendSuccess(() -> Component.literal(all.size() + " build(s)"), false);
		for (Build b : all) {
			src.sendSuccess(() -> Component.literal(b.id() + " " + b.state() + " " + b.kind().name().toLowerCase(Locale.ROOT) + " " + b.cells() + " cells at "
				+ b.bounds().minX() + " " + b.bounds().minY() + " " + b.bounds().minZ() + " r" + b.revision()), false);
		}
		return all.size();
	}

	private static int at(CommandContext<CommandSourceStack> c) {
		CommandSourceStack src = c.getSource();
		BlockPos p = BlockPosArgument.getBlockPos(c, "pos");
		ServerLevel level = src.getLevel();
		var r = BuildViews.placedBy(level, p);
		src.sendSuccess(() -> Component.literal(r.isEmpty() ? "not tracked" : "placed by " + r.get().placer() + (r.get().buildId() == null ? ", incidental"
			: ", in " + r.get().buildId())), false);
		return r.isPresent() ? 1 : 0;
	}

	private static int rule(CommandContext<CommandSourceStack> c, String name, String value) {
		CommandSourceStack src = c.getSource();
		Builds.Rules r = Builds.rules();
		try {
			if (name == null) {
				src.sendSuccess(() -> Component.literal(r.json().toString()), false);
				return 1;
			}
			String key = "architect.playerTracking".equals(name) ? "playerTracking" : name;
			Field f = Builds.Rules.class.getField(key);
			if (value != null) {
				Class<?> t = f.getType();
				if (t == boolean.class) {
					f.setBoolean(r, Boolean.parseBoolean(value));
				} else if (t == int.class) {
					f.setInt(r, Integer.parseInt(value));
				} else if (t == long.class) {
					f.setLong(r, Long.parseLong(value));
				}
				Builds.rulesChanged();
			}
			Object v = f.get(r);
			src.sendSuccess(() -> Component.literal(key + " = " + v), true);
			return 1;
		} catch (ReflectiveOperationException | NumberFormatException e) {
			src.sendFailure(Component.literal("no rule " + name + " (" + e.getMessage() + ")"));
			return 0;
		}
	}
}
