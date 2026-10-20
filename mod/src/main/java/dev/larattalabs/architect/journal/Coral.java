package dev.larattalabs.architect.journal;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.CoralBlock;
import net.minecraft.world.level.block.CoralFanBlock;
import net.minecraft.world.level.block.CoralPlantBlock;
import net.minecraft.world.level.block.CoralWallFanBlock;

/**
 * (6c F3 §6) The coral chain beside copper's: every dead coral block, plant, fan and wall fan has one canonical form, its live coral
 * ({@code dead_tube_coral_fan} -> {@code tube_coral_fan}). Read from vanilla at class load: each live coral block's own dead block (the
 * {@code deadBlock} field {@link CoralBlock}, {@link CoralPlantBlock}, {@link CoralFanBlock} and {@link CoralWallFanBlock} die into),
 * never a hand table nor a name rule, so a coral a later Minecraft version adds joins by itself. {@code CoralTest} pins the table against
 * kit/lib/blocks.mjs. A coral that died in a drained pond (removal drains first) is still the live coral the region wrote.
 */
public final class Coral {
	private Coral() {
	}

	/** Dead coral -> its live form (every live coral in the block registry, through its own dead block). */
	private static volatile Map<Block, Block> live;

	static Map<Block, Block> table() {
		Map<Block, Block> t = live;
		if (t == null) {
			Map<Block, Block> m = new HashMap<>();
			for (Block b : BuiltInRegistries.BLOCK) {
				Block dead = deadOf(b);
				if (dead != null && dead != b) {
					m.put(dead, b);
				}
			}
			live = t = Map.copyOf(m);
		}
		return t;
	}

	/** A live coral's dead block (vanilla's own field), or null when {@code b} is no live coral. */
	static Block deadOf(Block b) {
		if (!(b instanceof CoralBlock || b instanceof CoralPlantBlock || b instanceof CoralFanBlock || b instanceof CoralWallFanBlock)) {
			return null;
		}
		for (Class<?> c = b.getClass(); c != null && c != Block.class; c = c.getSuperclass()) {
			for (Field f : c.getDeclaredFields()) {
				if (f.getType() == Block.class && !Modifier.isStatic(f.getModifiers())) {
					try {
						f.setAccessible(true);
						return (Block) f.get(b);
					} catch (ReflectiveOperationException | RuntimeException e) {
						return null;
					}
				}
			}
		}
		return null;
	}

	/** The canonical (live) form of {@code b}: the live coral of a dead one; {@code b} itself otherwise. */
	public static Block canonical(Block b) {
		Block l = table().get(b);
		return l != null ? l : b;
	}

	/** Whether {@code b} is in a coral chain (a live coral or one's dead form). */
	public static boolean inChain(Block b) {
		return table().containsKey(b) || table().containsValue(b);
	}

	/** Whether {@code a} and {@code b} are the same block for "still ours": the same block, or a live coral and its dead form. */
	public static boolean sameBlock(Block a, Block b) {
		return a == b || inChain(a) && inChain(b) && canonical(a) == canonical(b);
	}
}
