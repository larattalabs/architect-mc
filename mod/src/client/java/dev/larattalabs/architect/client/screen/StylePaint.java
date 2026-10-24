package dev.larattalabs.architect.client.screen;

import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.client.library.LibraryFeature;
import dev.larattalabs.architect.library.Palettes;
import dev.larattalabs.architect.library.StyleCatalog;
import dev.larattalabs.architect.library.StyleRoles;
import dev.larattalabs.architect.library.StyleSheet;
import dev.larattalabs.architect.library.Swatches;
import dev.larattalabs.labui.client.picker.PickerEntry;
import dev.larattalabs.labui.client.picker.PickerSpec;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.labui.client.widget.Paint;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import org.jspecify.annotations.Nullable;

/**
 * (Style unification U3) How the Style screens paint: a block's swatch colour (the checked-in texture table, else the game's map colour),
 * a Style's preview sheet ({@link StyleSheet}: every part one of its roles), and the picker entries of the material rows, the role
 * picker and the Style browser. Theming rule: nothing here paints a block that isn't the Style's. Client thread.
 */
public final class StylePaint {
	private static final Map<String, Integer> MAP_COLOURS = new HashMap<>();
	/** The sky behind a sheet (the UI's, not a block). */
	private static final int SKY_TOP = 0xFFDCE6EC;
	private static final int SKY_BOTTOM = 0xFFC9D8E2;

	private StylePaint() {
	}

	/** A block's RGB: the texture table's, else its map colour, else a neutral grey. */
	public static int rgb(@Nullable String block) {
		Integer t = Swatches.rgb(block);
		if (t != null) {
			return t;
		}
		if (block == null) {
			return 0x8A8A8A;
		}
		return MAP_COLOURS.computeIfAbsent(block, b -> {
			Identifier id = Identifier.tryParse(b.contains(":") ? b : "minecraft:" + b);
			Block bl = id == null ? null : BuiltInRegistries.BLOCK.getOptional(id).orElse(null);
			if (bl == null) {
				return 0x8A8A8A;
			}
			int c = bl.defaultMapColor().col;
			return c == 0 ? 0x8A8A8A : c;
		});
	}

	static int shade(int rgb, int shade) {
		if (shade == 0) {
			return 0xFF000000 | rgb;
		}
		int r = rgb >> 16 & 0xFF;
		int g = rgb >> 8 & 0xFF;
		int b = rgb & 0xFF;
		double f = shade > 0 ? 1.12 : 0.80;
		r = Math.min(255, (int) (r * f));
		g = Math.min(255, (int) (g * f));
		b = Math.min(255, (int) (b * f));
		return 0xFF000000 | r << 16 | g << 8 | b;
	}

	/** A Style's preview sheet in a box: the UI's sky, then every part from a role, scaled to fit and centred. */
	public static void sheet(GuiGraphicsExtractor g, Map<String, String> roles, int x, int y, int w, int h) {
		g.fillGradient(x, y, x + w, y + h, SKY_TOP, SKY_BOTTOM);
		if (w < 8 || h < 6) {
			return;
		}
		double s = Math.min(w / (double) StyleSheet.W, h / (double) StyleSheet.H);
		int ox = x + (int) ((w - StyleSheet.W * s) / 2);
		int oy = y + (int) ((h - StyleSheet.H * s) / 2);
		for (StyleSheet.Part p : StyleSheet.parts(roles)) {
			int x0 = ox + (int) Math.floor(p.x() * s);
			int y0 = oy + (int) Math.floor(p.y() * s);
			int x1 = ox + (int) Math.ceil((p.x() + p.w()) * s);
			int y1 = oy + (int) Math.ceil((p.y() + p.h()) * s);
			if (x1 <= x0) {
				x1 = x0 + 1;
			}
			if (y1 <= y0) {
				y1 = y0 + 1;
			}
			g.fill(Math.max(x, x0), Math.max(y, y0), Math.min(x + w, x1), Math.min(y + h, y1), shade(rgb(p.block()), p.shade()));
		}
		// a ground line under the plinth (the UI's rule) when the Style has no surface role
		if (!roles.containsKey("surface")) {
			int gy = oy + (int) Math.round(52 * s);
			g.fill(x, Math.min(y + h - 1, gy), x + w, Math.min(y + h, gy + 1), UiStyle.withAlpha(UiStyle.WALNUT, 90));
		}
	}

	/** A block's item icon supplier, or null for a block without one. */
	static java.util.function.@Nullable Supplier<ItemStack> icon(@Nullable String block) {
		Identifier key = block == null ? null : Identifier.tryParse(block.contains(":") ? block : "minecraft:" + block);
		Item it = key == null ? null : BuiltInRegistries.ITEM.getOptional(key).orElse(null);
		if (it == null || it == Items.AIR) {
			return null;
		}
		return () -> new ItemStack(it);
	}

	static String label(String v) {
		String s = v.replace("minecraft:", "").replace('_', ' ');
		return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1);
	}

	/**
	 * The picker of a main row (Wood / Stone / Roof / Accent): its choices as swatches grouped by family; the detail pane shows the
	 * current roles with the hovered choice put in that row ({@code roles}, null: no preview).
	 */
	public static PickerSpec material(String field, @Nullable String current, @Nullable Map<String, String> roles, Consumer<String> pick) {
		Palettes pal = LibraryFeature.palettes();
		List<PickerEntry> entries = new ArrayList<>();
		List<String> groups = new ArrayList<>();
		for (String v : pal.choices(field)) {
			String block = Swatches.blockOf(field, v);
			String fam = Swatches.family(field, v);
			if (!groups.contains(fam)) {
				groups.add(fam);
			}
			entries.add(PickerEntry.of(v, label(v)).group(fam).swatch(rgb(block)).subtitle(block).attr("block", block).build());
		}
		String noun = switch (field) {
			case "wood" -> "woods";
			case "stone" -> "stones";
			case "roof" -> "roof materials";
			default -> "accent woods";
		};
		StyleRoles table = StyleRoles.fallback();
		return PickerSpec.of("architect_mc.material." + field, "Choose " + (field.equals("roof") ? "roof material" : field.equals("accent")
			? "accent wood" : field), entries).current(current).groupOrder(groups).noun(noun).compactChoices(3).detailPreview(roles == null ? null
				: (g, font, e, x, y, w, h) -> {
					Map<String, String> r;
					try {
						r = table.editMain(roles, field, e.id());
					} catch (RuntimeException ex) {
						r = roles;
					}
					sheet(g, r, x, y, w, h);
				}).onPick(e -> pick.accept(e.id()));
	}

	/** The picker of one role ("More roles"): every block the swatch table knows, grouped by what it is for. */
	public static PickerSpec role(String role, @Nullable String current, Consumer<String> pick) {
		List<PickerEntry> entries = new ArrayList<>();
		List<String> groups = new ArrayList<>();
		List<String> blocks = new ArrayList<>(Swatches.blocks());
		if (current != null && !blocks.contains(current)) {
			blocks.add(0, current);
		}
		for (String b : blocks) {
			String fam = Swatches.blockFamily(b);
			if (!groups.contains(fam)) {
				groups.add(fam);
			}
			entries.add(PickerEntry.of(b, Swatches.label(b)).group(fam).swatch(rgb(b)).subtitle(b).build());
		}
		return PickerSpec.of("architect_mc.role", "Choose the " + role.replace('_', ' ') + " block", entries).current(current).groupOrder(groups)
			.noun("blocks").onPick(e -> pick.accept(e.id()));
	}

	/** A Style browser card: the sheet from its roles, its tags, its rail, and the detail lines. */
	static PickerEntry styleEntry(StyleCatalog.Card c) {
		Bible b = c.bible();
		Map<String, String> roles = b.roles();
		return PickerEntry.of(b.id(), b.name()).group(c.rail()).tags(b.tags()).subtitle(b.builtin() ? "built-in" : b.id() + " v" + b.version())
			.preview((g, font, x, y, w, h) -> sheet(g, roles, x, y, w, h)).details(c::details).attr("card", c).build();
	}

	/** A small swatch box (Paint's, with the block's colour). */
	static void swatch(GuiGraphicsExtractor g, @Nullable String block, int x, int y, int w, int h) {
		Paint.swatch(g, x, y, w, h, rgb(block));
	}

	static int textWidth(Font f, String s) {
		return f.width(s);
	}
}
