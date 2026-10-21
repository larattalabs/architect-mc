package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.security.MessageDigest;
import java.util.List;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (v0.40.1) RegionHash's exclude: a snap holds every cell of the box, and a diff reads an excluded cell's entry before skipping
 * it. Before the fix the diff skipped the read, so every cell after an excluded one was compared with the entry before it
 * (the drain-holders gates' E-flat 18 of 40).
 */
class RegionHashExcludeTest {
	private static final int[] BOX = {0, 0, 0, 4, 0, 0};
	private static final String[] WORLD = {"minecraft:stone", "minecraft:oak_planks", "minecraft:cobblestone", "minecraft:glass", "minecraft:bricks"};

	private static byte[] snap(boolean[] excluded) throws Exception {
		Boot.boot();
		ByteArrayOutputStream bytes = new ByteArrayOutputStream();
		RegionHash.Job j = new RegionHash.Job(null, BOX, List.of(), RegionHash.Mode.SNAP, null);
		j.out = new DataOutputStream(bytes);
		MessageDigest md = MessageDigest.getInstance("SHA-256");
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (int x = 0; x < WORLD.length; x++) {
			RegionHash.cell(j, md, m.set(x, 0, 0), excluded[x], WORLD[x]);
		}
		j.out.flush();
		assertEquals(WORLD.length, j.cells, "a snap holds every cell, excluded or not");
		return bytes.toByteArray();
	}

	private static RegionHash.Job diff(byte[] snap, String[] now, boolean[] excluded) throws Exception {
		Boot.boot();
		RegionHash.Job j = new RegionHash.Job(null, BOX, List.of(), RegionHash.Mode.DIFF, null);
		j.in = new DataInputStream(new ByteArrayInputStream(snap));
		j.snapPalette = List.of(WORLD);
		MessageDigest md = MessageDigest.getInstance("SHA-256");
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (int x = 0; x < now.length; x++) {
			RegionHash.cell(j, md, m.set(x, 0, 0), excluded[x], now[x]);
		}
		return j;
	}

	@Test
	void anExcludedCellKeepsTheLaterCellsPaired() throws Exception {
		byte[] s = snap(new boolean[5]);
		String[] now = WORLD.clone();
		now[1] = "minecraft:oak_stairs"; // a player's block in the excluded cell
		RegionHash.Job j = diff(s, now, new boolean[] {false, true, false, false, false});
		assertEquals(0, j.mismatchCount, "every cell after the excluded one compared with its own entry: " + j.mismatches);
		assertEquals(4, j.cells);
	}

	@Test
	void aSnapTakenWithAnExcludeStillDiffsCellForCell() throws Exception {
		boolean[] ex = {false, false, true, false, false};
		byte[] s = snap(ex);
		String[] now = WORLD.clone();
		now[4] = "minecraft:dirt";
		RegionHash.Job j = diff(s, now, ex);
		assertEquals(1, j.mismatchCount, j.mismatches.toString());
		assertEquals("4,0,0", j.mismatches.get(0).getAsJsonObject().get("pos").getAsString());
	}
}
