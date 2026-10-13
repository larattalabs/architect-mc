package dev.larattalabs.architect.region;

import com.google.gson.JsonParser;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BrushKind;
import dev.larattalabs.architect.api.BrushRequest;
import dev.larattalabs.architect.api.BrushShape;
import dev.larattalabs.architect.api.Destruction;
import dev.larattalabs.architect.api.Limits;
import dev.larattalabs.architect.api.Mask;
import dev.larattalabs.architect.api.Pattern;
import dev.larattalabs.architect.api.RegionView;
import dev.larattalabs.architect.api.RemoveOptions;
import java.util.Locale;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import org.jspecify.annotations.Nullable;

/**
 * {@code /architect brush} (docs/CONTRACT.md "Phase 6c slice B" §5): one stroke at the block the player looks at (reach 64), owned by
 * {@code architect:player}, with the player as its actor. Creative or permission level 2; {@code player_blocks} needs permission 2
 * (the console too: it names the block with {@code at x y z}).
 * <pre>
 * /architect brush &lt;kind&gt; [radius] [strength] [options]   options, any order: sphere | cylinder, mask {json}, pattern {json},
 *                                                       player_blocks, seed &lt;n&gt;, at &lt;x&gt; &lt;y&gt; &lt;z&gt;
 * /architect brush undo                                  this player's (or the console's) last stroke
 * </pre>
 */
public final class BrushCommands {
	/** The reach of the look (blocks). */
	public static final double REACH = 64;
	static final int DEFAULT_RADIUS = 6;
	static final int DEFAULT_STRENGTH = 3;

	private BrushCommands() {
	}

	public static void init() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registry, env) -> {
			var kind = Commands.argument("kind", StringArgumentType.word()).suggests((c, b) -> {
				for (BrushKind k : BrushKind.values()) {
					b.suggest(k.name().toLowerCase(Locale.ROOT));
				}
				return b.buildFuture();
			}).executes(ctx -> stroke(ctx, DEFAULT_RADIUS, DEFAULT_STRENGTH, ""));
			RequiredArgumentBuilder<CommandSourceStack, Integer> radius = Commands.argument("radius", IntegerArgumentType.integer(Limits.BRUSH_RADIUS_MIN,
				Limits.BRUSH_RADIUS_MAX)).executes(ctx -> stroke(ctx, IntegerArgumentType.getInteger(ctx, "radius"), DEFAULT_STRENGTH, ""));
			RequiredArgumentBuilder<CommandSourceStack, Integer> strength = Commands.argument("strength", IntegerArgumentType.integer(Limits.BRUSH_STRENGTH_MIN,
				Limits.BRUSH_STRENGTH_MAX)).executes(ctx -> stroke(ctx, IntegerArgumentType.getInteger(ctx, "radius"), IntegerArgumentType.getInteger(ctx,
					"strength"), ""));
			strength.then(Commands.argument("options", StringArgumentType.greedyString()).executes(ctx -> stroke(ctx, IntegerArgumentType.getInteger(ctx,
				"radius"), IntegerArgumentType.getInteger(ctx, "strength"), StringArgumentType.getString(ctx, "options"))));
			radius.then(strength);
			kind.then(radius);
			dispatcher.register(Commands.literal("architect").then(Commands.literal("brush").requires(BrushCommands::allowed)
				.then(Commands.literal("undo").executes(BrushCommands::undo))
				.then(kind)));
		});
	}

	/** Creative or permission level 2. */
	static boolean allowed(CommandSourceStack src) {
		if (src.permissions().hasPermission(net.minecraft.server.permissions.Permissions.COMMANDS_GAMEMASTER)) {
			return true;
		}
		ServerPlayer p = src.getPlayer();
		return p != null && p.isCreative();
	}

	/** The parsed options. */
	record Options(BrushShape shape, @Nullable Mask mask, @Nullable Pattern pattern, Destruction destruction, long seed, @Nullable BlockPos at) {
	}

	/** Parses the options tail (any order). Throws IllegalArgumentException with the reason. Pure. */
	static Options options(String text) {
		BrushShape shape = BrushShape.SPHERE;
		Mask mask = null;
		Pattern pattern = null;
		Destruction d = Destruction.NATURAL_ONLY;
		long seed = 0;
		BlockPos at = null;
		int i = 0;
		String s = text.trim();
		while (i < s.length()) {
			while (i < s.length() && s.charAt(i) == ' ') {
				i++;
			}
			if (i >= s.length()) {
				break;
			}
			int j = i;
			while (j < s.length() && s.charAt(j) != ' ') {
				j++;
			}
			String w = s.substring(i, j).toLowerCase(Locale.ROOT);
			i = j;
			switch (w) {
				case "sphere" -> shape = BrushShape.SPHERE;
				case "cylinder" -> shape = BrushShape.CYLINDER;
				case "player_blocks" -> d = Destruction.PLAYER_BLOCKS;
				case "natural_only" -> d = Destruction.NATURAL_ONLY;
				case "mask", "pattern" -> {
					int[] span = json(s, i);
					String js = s.substring(span[0], span[1]);
					i = span[1];
					if (w.equals("mask")) {
						mask = Mask.parse(js);
					} else {
						pattern = Pattern.parse(js);
					}
				}
				case "seed", "at" -> {
					int n = w.equals("seed") ? 1 : 3;
					long[] v = new long[n];
					for (int k = 0; k < n; k++) {
						while (i < s.length() && s.charAt(i) == ' ') {
							i++;
						}
						int e = i;
						while (e < s.length() && s.charAt(e) != ' ') {
							e++;
						}
						try {
							v[k] = Long.parseLong(s.substring(i, e));
						} catch (NumberFormatException ex) {
							throw new IllegalArgumentException(w + ": a number expected, got \"" + s.substring(i, e) + "\"");
						}
						i = e;
					}
					if (w.equals("seed")) {
						seed = v[0];
					} else {
						at = new BlockPos((int) v[0], (int) v[1], (int) v[2]);
					}
				}
				default -> throw new IllegalArgumentException("unknown option \"" + w + "\" (sphere, cylinder, mask {..}, pattern {..}, player_blocks, seed n, at x y z)");
			}
		}
		return new Options(shape, mask, pattern, d, seed, at);
	}

	/** The span [start, end) of the JSON object starting at the first '{' at or after {@code from}. */
	static int[] json(String s, int from) {
		int i = from;
		while (i < s.length() && s.charAt(i) == ' ') {
			i++;
		}
		if (i >= s.length() || s.charAt(i) != '{') {
			throw new IllegalArgumentException("a JSON object {..} expected at \"" + s.substring(Math.min(i, s.length())) + "\"");
		}
		int depth = 0;
		boolean str = false;
		for (int j = i; j < s.length(); j++) {
			char c = s.charAt(j);
			if (str) {
				if (c == '\\') {
					j++;
				} else if (c == '"') {
					str = false;
				}
				continue;
			}
			if (c == '"') {
				str = true;
			} else if (c == '{' || c == '[') {
				depth++;
			} else if (c == '}' || c == ']') {
				depth--;
				if (depth == 0) {
					JsonParser.parseString(s.substring(i, j + 1)); // a parse error names the problem
					return new int[] {i, j + 1};
				}
			}
		}
		throw new IllegalArgumentException("the JSON object is not closed");
	}

	private static int stroke(CommandContext<CommandSourceStack> ctx, int radius, int strength, String opts) {
		CommandSourceStack src = ctx.getSource();
		String k = StringArgumentType.getString(ctx, "kind").toUpperCase(Locale.ROOT);
		BrushKind kind;
		try {
			kind = BrushKind.valueOf(k);
		} catch (IllegalArgumentException e) {
			src.sendFailure(Component.literal("No brush \"" + k.toLowerCase(Locale.ROOT) + "\": smooth, erode, melt, blend, raise, lower, overlay, cave_carve"));
			return 0;
		}
		Options o;
		try {
			o = options(opts);
		} catch (ArchitectRefused | IllegalArgumentException | com.google.gson.JsonParseException e) {
			src.sendFailure(Component.literal("Brush options: " + e.getMessage()));
			return 0;
		}
		ServerPlayer p = src.getPlayer();
		BlockPos at = o.at();
		if (at == null) {
			if (p == null) {
				src.sendFailure(Component.literal("From the console, name the block: at <x> <y> <z>"));
				return 0;
			}
			HitResult hit = p.pick(REACH, 1.0f, false);
			if (!(hit instanceof BlockHitResult bh) || hit.getType() != HitResult.Type.BLOCK) {
				src.sendFailure(Component.literal("Look at a block within " + (int) REACH + " blocks"));
				return 0;
			}
			at = bh.getBlockPos();
		}
		boolean console = p == null;
		BrushRequest r = new BrushRequest(Brushes.PLAYER_OWNER, Level.OVERWORLD, kind, o.shape(), at, radius, strength, o.mask(), o.pattern(), o.destruction(),
			p == null ? null : p.getUUID(), o.seed());
		BlockPos fat = at;
		src.sendSuccess(() -> Component.literal("Brush " + kind.name().toLowerCase(Locale.ROOT) + " r" + radius + " s" + strength + " at " + fat.toShortString()
			+ "..."), false);
		Brushes.stroke(r, console).whenComplete((v, e) -> src.getServer().execute(() -> {
			if (e != null) {
				src.sendFailure(Component.literal("Brush refused: " + why(e)));
			} else {
				src.sendSuccess(() -> Component.literal(summary(v)), false);
			}
		}));
		return 1;
	}

	static String summary(RegionView v) {
		StringBuilder b = new StringBuilder("Stroke " + v.id() + " " + v.state().name().toLowerCase(Locale.ROOT) + ": " + v.cellsWritten() + " cells");
		if (!v.cellsSkipped().isEmpty()) {
			b.append(", skipped ").append(v.cellsSkipped());
		}
		return b.append(" (/architect brush undo)").toString();
	}

	private static int undo(CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack src = ctx.getSource();
		ServerPlayer p = src.getPlayer();
		String actor = p == null ? Brushes.CONSOLE : p.getUUID().toString();
		RegionsImpl.Live l = Brushes.lastOf(actor);
		if (l == null) {
			src.sendFailure(Component.literal("No stroke of yours to undo"));
			return 0;
		}
		String id = l.rec().id;
		RegionsImpl.INSTANCE.remove(id, new RemoveOptions(false, l.rec().owner)).whenComplete((res, e) -> src.getServer().execute(() -> {
			if (e != null || res == null || !res.removed()) {
				src.sendFailure(Component.literal("Stroke " + id + " not undone: " + (e != null ? why(e) : res == null ? "?" : String.join("; ", res.blockers()))));
			} else {
				src.sendSuccess(() -> Component.literal("Stroke " + id + " undone"), false);
			}
		}));
		return 1;
	}

	static String why(Throwable e) {
		Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
		return c instanceof ArchitectRefused a ? a.reason() + ": " + a.getMessage() : String.valueOf(c.getMessage());
	}
}
