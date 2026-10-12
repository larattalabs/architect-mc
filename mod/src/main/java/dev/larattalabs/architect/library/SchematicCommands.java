package dev.larattalabs.architect.library;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.placement.Blueprints;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.concurrent.CompletionException;
import java.util.stream.Stream;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;

/**
 * {@code /architect export <entry> schem} (to {@code <gameDir>/architect/exports/<entry>/<entry>.schem}) and
 * {@code /architect import <file>} (a {@code .schem} in {@code <gameDir>/architect/imports/}, through the helper)
 * (docs/CONTRACT.md "Phase 6c slice SCH" §4). The contract's {@code architect/import/} is the existing import folder,
 * {@code architect/imports/}. Both need permission level 2.
 */
public final class SchematicCommands {
	private SchematicCommands() {
	}

	public static void init() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registry, env) -> dispatcher.register(Commands.literal("architect")
			.then(Commands.literal("export").requires(SchematicCommands::gamemaster)
				.then(Commands.argument("entry", StringArgumentType.word())
					.suggests((ctx, b) -> {
						Blueprints.ids().forEach(b::suggest);
						return b.buildFuture();
					})
					.then(Commands.literal("schem").executes(SchematicCommands::export))))
			.then(Commands.literal("import").requires(SchematicCommands::gamemaster)
				.then(Commands.argument("file", StringArgumentType.greedyString())
					.suggests((ctx, b) -> {
						for (String f : importable()) {
							b.suggest(f.contains(" ") ? '"' + f + '"' : f);
						}
						return b.buildFuture();
					})
					.executes(SchematicCommands::importFile)))));
	}

	/** Files are written and read on the server's disk: permission level 2. */
	static boolean gamemaster(CommandSourceStack src) {
		return src.permissions().hasPermission(net.minecraft.server.permissions.Permissions.COMMANDS_GAMEMASTER);
	}

	/** The {@code .schem} files under {@code imports/}, relative, sorted. */
	static java.util.List<String> importable() {
		Path dir = Exchange.importsDir(Blueprints.gameDataDir());
		if (!Files.isDirectory(dir)) {
			return java.util.List.of();
		}
		try (Stream<Path> s = Files.walk(dir, 8)) {
			return s.filter(p -> Files.isRegularFile(p) && p.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".schem"))
				.map(p -> dir.relativize(p).toString().replace('\\', '/')).sorted().limit(200).toList();
		} catch (IOException e) {
			return java.util.List.of();
		}
	}

	private static int export(CommandContext<CommandSourceStack> ctx) {
		String id = StringArgumentType.getString(ctx, "entry");
		CommandSourceStack src = ctx.getSource();
		MinecraftServer server = src.getServer();
		Path dir = Exchange.exportDir(Blueprints.gameDataDir(), id);
		ArchitectApi.get().library().exportSchematic(id, null, dir).whenComplete((p, err) -> server.execute(() -> {
			if (err != null) {
				src.sendFailure(Component.literal("Not exported: " + why(err)));
			} else {
				src.sendSuccess(() -> Component.literal("Exported " + id + " to architect/exports/" + id + "/" + p.getFileName()), false);
			}
		}));
		return 1;
	}

	private static int importFile(CommandContext<CommandSourceStack> ctx) {
		String rel = StringArgumentType.getString(ctx, "file").strip();
		if (rel.length() > 1 && rel.startsWith("\"") && rel.endsWith("\"")) {
			rel = rel.substring(1, rel.length() - 1);
		}
		CommandSourceStack src = ctx.getSource();
		Path root = Exchange.importsDir(Blueprints.gameDataDir()).toAbsolutePath().normalize();
		Path file = root.resolve(rel).normalize();
		if (!file.startsWith(root) || !file.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".schem")) {
			src.sendFailure(Component.literal("Name a .schem file in architect/imports/ (got " + rel + ")"));
			return 0;
		}
		MinecraftServer server = src.getServer();
		src.sendSuccess(() -> Component.literal("Importing " + file.getFileName() + "..."), false);
		ArchitectApi.get().library().importSchematic(file, null).whenComplete((e, err) -> server.execute(() -> {
			if (err != null) {
				src.sendFailure(Component.literal("Not imported: " + why(err)));
			} else {
				src.sendSuccess(() -> Component.literal("Imported " + file.getFileName() + " as " + e.id() + " (" + e.name() + ", " + e.size().x() + "x"
					+ e.size().y() + "x" + e.size().z() + ")"), false);
			}
		}));
		return 1;
	}

	static String why(Throwable err) {
		Throwable t = err instanceof CompletionException && err.getCause() != null ? err.getCause() : err;
		if (t instanceof ArchitectRefused r) {
			return r.reason() + ": " + r.getMessage();
		}
		Architect.LOGGER.debug("schematic command failed", t);
		return t.getMessage() == null ? t.toString() : t.getMessage();
	}
}
