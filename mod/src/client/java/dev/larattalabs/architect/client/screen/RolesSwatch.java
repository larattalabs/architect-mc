package dev.larattalabs.architect.client.screen;

import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.client.design.PreviewImages;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import org.jspecify.annotations.Nullable;

/**
 * A style bible at a glance (phase 4b): its roles as a row of block icons (wall, trim, roof, ...), and its sample sheet
 * ({@code sheet.png}) through {@link PreviewImages}. Client thread.
 */
final class RolesSwatch {
	/** The roles shown first, in this order; extra named roles follow. */
	static final java.util.List<String> ORDER = java.util.List.of("wall", "wall_alt", "trim", "roof", "frame", "accent", "floor", "glass", "light",
		"foundation", "path");

	private RolesSwatch() {
	}

	/** Draws the roles as 16 px icons from {@code x}, as many as fit in {@code w}; returns how many were drawn. */
	static int draw(GuiGraphicsExtractor g, Bible b, int x, int y, int w) {
		int n = 0;
		int cx = x;
		java.util.List<String> roles = new java.util.ArrayList<>();
		for (String r : ORDER) {
			if (b.roles().containsKey(r)) {
				roles.add(r);
			}
		}
		for (Map.Entry<String, String> e : b.roles().entrySet()) {
			if (!roles.contains(e.getKey())) {
				roles.add(e.getKey());
			}
		}
		for (String r : roles) {
			if (cx + 16 > x + w) {
				break;
			}
			Item it = item(b.roles().get(r));
			if (it == null) {
				continue;
			}
			g.item(new ItemStack(it), cx, y);
			cx += 17;
			n++;
		}
		return n;
	}

	static @Nullable Item item(@Nullable String blockId) {
		Identifier key = blockId == null ? null : Identifier.tryParse(blockId);
		Item it = key == null ? null : BuiltInRegistries.ITEM.getOptional(key).orElse(null);
		return it == null || it == Items.AIR ? null : it;
	}

	/** The bible's sheet as a preview image, or null when it has none on disk. */
	static PreviewImages.@Nullable Found sheet(Bible b) {
		Path p = b.sheetPath().orElse(null);
		if (p == null || !Files.isRegularFile(p)) {
			return null;
		}
		try {
			return new PreviewImages.Found("sheet", "user", p, null, p + "@" + Files.getLastModifiedTime(p).toMillis() + "#" + Files.size(p));
		} catch (IOException e) {
			return null;
		}
	}
}
