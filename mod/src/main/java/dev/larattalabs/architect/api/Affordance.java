package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Locale;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (7b) A place in the land a site-aware design can use (docs/CONTRACT.md "Phase 7b" §2, SETTLEMENTS §6): found by a deterministic
 * analysis of a frozen volume at plan time ({@link Survey#site}, a region plan's {@code affordances[]}). The analysis is slice AF's;
 * this record is the shape it answers in. Since NEXT.
 *
 * @param id stable: a hash of the kind and the geometry quantized to 4 (box and normal), so a re-analysis of unchanged land gives
 *           the same id (6d replanning keys on it)
 * @param kind what it is
 * @param box its extent in the world
 * @param anchors the cells a design bears on or hangs from (a face's bearing row, a ledge's lip, a trunk's axis, a ceiling's hang
 *                points)
 * @param normal the side open to the air (a cliff face's), or null when it has none (a trunk, a pad)
 * @param metrics the kind's measures (size, height, depth, radius, span, floor area, ...), by name
 * @param score how good a lot it makes (size, access, exposure, the plan's preferences); higher is better
 */
public record Affordance(String id, Kind kind, BoundingBox box, List<BlockPos> anchors, @Nullable Direction normal, JsonObject metrics, double score) {
	public Affordance {
		anchors = anchors == null ? List.of() : List.copyOf(anchors);
		metrics = metrics == null ? new JsonObject() : metrics;
	}

	/** The kinds of affordance (SETTLEMENTS §6's table). New values are only ever appended. Since NEXT. */
	public enum Kind {
		CLIFF_FACE, LEDGE, OVERHANG, CAVE, TRUNK, CANOPY, SPIKE, WATER, GAP, PAD;

		/** The wire name: the lowercase name ({@code cliff_face}). */
		public String wire() {
			return name().toLowerCase(Locale.ROOT);
		}
	}
}
