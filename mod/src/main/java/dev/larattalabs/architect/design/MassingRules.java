package dev.larattalabs.architect.design;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.BlueprintTransform;
import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * The phase 4c UI rules (docs/CONTRACT.md "Phase 4c contract", "UI"): when "Massing first" is on by default, the detail request
 * an Approve sends, where a massing ghost stands (in front of the player, or on a marked plot) and how a set's massings line up
 * in a row. Pure logic (no Minecraft classes beyond the shared transforms), tested without a game.
 */
public final class MassingRules {
	/** The gap between a set's massings in a row (blocks). */
	public static final int ROW_GAP = 4;
	/** How far ahead of the looked-at spot a massing ghost starts (blocks). */
	public static final int AHEAD = 2;

	private MassingRules() {
	}

	/** "Massing first" is on by default for the large and the plot sizes (a big or sited building is worth a cheap shape first). */
	public static boolean massingFirstByDefault(@Nullable String size) {
		return "L".equals(size) || "plot".equals(size);
	}

	/**
	 * The detail pass of a massing as the Design tab sends it on Approve: the massing's own request (as the sidecar ran it) with
	 * the massing-only fields dropped ({@code massing}, {@code redirect}, the massing {@code model} the sidecar wrote in, a
	 * group's fields) and {@code fromMassing} + {@code massingVersion} set.
	 */
	public static JsonObject detailRequest(JsonObject massingRequest, String massingId, int version) {
		JsonObject r = massingRequest.deepCopy();
		for (String k : new String[] {"massing", "redirect", "model", "group", "itemKey", "wave", "role", "anchor", "fromMassing", "massingVersion",
			"bibleVersion"}) {
			r.remove(k);
		}
		r.addProperty("fromMassing", massingId);
		r.addProperty("massingVersion", version);
		return r;
	}

	/** A massing to stand in a row: its template size and front. */
	public record Box(int sizeX, int sizeZ, int groundY, String front) {
	}

	/**
	 * Where massings stand side by side in front of the player looking {@code facing} from the spot {@code (x, y, z)}: each
	 * turned so its entrance faces the player, in a row across the view (left to right as listed), centred on the spot,
	 * {@code ahead} blocks out, {@link #ROW_GAP} apart. Returns {x, y, z, turns} per box (the rotated box's minimum corner).
	 */
	public static List<int[]> row(int x, int y, int z, String facing, List<Box> boxes, int ahead) {
		String towards = BlueprintTransform.rotateDirection(facing, 2);
		boolean acrossX = "north".equals(facing) || "south".equals(facing);
		// the player's right: facing north (-z) it is +x, south -x, east +z, west -z
		int sign = switch (facing) {
			case "north", "east" -> 1;
			default -> -1;
		};
		int[] widths = new int[boxes.size()];
		int[] turns = new int[boxes.size()];
		int total = 0;
		for (int i = 0; i < boxes.size(); i++) {
			Box b = boxes.get(i);
			turns[i] = BlueprintTransform.turnsToFace(b.front(), towards);
			int rsx = BlueprintTransform.rotatedSizeX(b.sizeX(), b.sizeZ(), turns[i]);
			int rsz = BlueprintTransform.rotatedSizeZ(b.sizeX(), b.sizeZ(), turns[i]);
			widths[i] = acrossX ? rsx : rsz;
			total += widths[i] + (i > 0 ? ROW_GAP : 0);
		}
		List<int[]> out = new ArrayList<>();
		int at = -total / 2;
		for (int i = 0; i < boxes.size(); i++) {
			Box b = boxes.get(i);
			int rsx = BlueprintTransform.rotatedSizeX(b.sizeX(), b.sizeZ(), turns[i]);
			int rsz = BlueprintTransform.rotatedSizeZ(b.sizeX(), b.sizeZ(), turns[i]);
			int centre = at + widths[i] / 2;
			int px = acrossX ? x + sign * centre : x;
			int pz = acrossX ? z : z + sign * centre;
			int[] o = BlueprintTransform.originInFront(px, y, pz, facing, rsx, rsz, b.groundY(), ahead);
			out.add(new int[] {o[0], o[1], o[2], turns[i]});
			at += widths[i] + ROW_GAP;
		}
		return out;
	}
}
