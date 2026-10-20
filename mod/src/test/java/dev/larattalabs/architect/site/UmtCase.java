package dev.larattalabs.architect.site;

import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.Pt;
import dev.larattalabs.architect.placement.Anchors;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.stream.Stream;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;

/**
 * A targeted UMT property's world (docs/UMT.md): a {@link UmtSim} with no generated operations over a flat area, x/z 30..37 at
 * ground {@link UmtWorld#GROUND}, built by hand step by step through the same production calls the fuzzer drives.
 */
final class UmtCase implements AutoCloseable {
	static final int X = 30;
	static final int Z = 30;
	static final int G = UmtWorld.GROUND;

	final UmtSim sim;
	private final Path dir;

	private UmtCase(UmtSim sim, Path dir) {
		this.sim = sim;
		this.dir = dir;
	}

	static UmtCase of(long seed, Consumer<UmtWorld> prep) {
		UmtRunner.boot();
		try {
			Path d = Files.createTempDirectory("umt-case");
			UmtSim s = new UmtSim(new UmtOps.Scenario(seed, List.of(), UmtOps.Gen.PLAIN), d.resolve("world"), w -> {
				w.flat(X, Z, X + 7, Z + 7);
				prep.accept(w);
			});
			return new UmtCase(s, d);
		} catch (IOException e) {
			throw new IllegalStateException(e);
		}
	}

	static UmtCase of(Consumer<UmtWorld> prep) {
		return of(1L, prep);
	}

	static long p(int dx, int y, int dz) {
		return BlockPos.asLong(X + dx, y, Z + dz);
	}

	static Map<Long, BlockState> cells(Object... posState) {
		Map<Long, BlockState> m = new LinkedHashMap<>();
		for (int i = 0; i + 1 < posState.length; i += 2) {
			m.put((Long) posState[i], posState[i + 1] instanceof Block b ? b.defaultBlockState() : (BlockState) posState[i + 1]);
		}
		return m;
	}

	/** A site over [dx0..dx1] x [y0..y1] x [dz0..dz1] whose cells are {@code fill} except {@code also}. */
	UmtSim.Rec site(int dx0, int y0, int dz0, int dx1, int y1, int dz1, BlockState fill, Map<Long, BlockState> also, int group) throws Exception {
		Anchors.Bounds b = new Anchors.Bounds(X + dx0, y0, Z + dz0, X + dx1, y1, Z + dz1);
		Map<Long, BlockState> d = new LinkedHashMap<>();
		for (int y = y0; y <= y1; y++) {
			for (int z = dz0; z <= dz1; z++) {
				for (int x = dx0; x <= dx1; x++) {
					d.put(p(x, y, z), fill);
				}
			}
		}
		d.putAll(also);
		return sim.site(b, d, group);
	}

	BlockState at(long p) {
		return sim.world.get(p);
	}

	Pt record(long p) {
		return sim.world.record(p);
	}

	Value value(long p) {
		return sim.world.value(p);
	}

	@Override
	public void close() {
		sim.close();
		try (Stream<Path> s = Files.walk(dir)) {
			for (Path f : s.sorted(Comparator.reverseOrder()).toList()) {
				Files.deleteIfExists(f);
			}
		} catch (IOException e) {
			// a temp folder left behind
		}
	}
}
