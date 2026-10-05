package dev.larattalabs.architect.client.survival;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import dev.larattalabs.architect.client.placement.TemplateCells;
import java.util.Set;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderContext;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.world.phys.Vec3;

/**
 * Draws the remaining cells of every construction site the client knows ({@link SiteGhosts}) translucent, in their block's
 * map colour (the same look as the placement ghost), and the next cells whose items the crate holds in green: what the
 * builder places next. Exposed faces only; one {@code submitCustomGeometry} per site per frame.
 */
final class SiteGhostRenderer {
	static final int ALPHA = 0x48;
	static final int NEXT = 0xA05FD068;
	static final float INFLATE = 0.004f;
	private static final float[] FACE_SHADE = {0.62f, 1.0f, 0.86f, 0.86f, 0.74f, 0.74f};
	static volatile int lastQuads;

	private SiteGhostRenderer() {
	}

	static void submit(LevelRenderContext ctx) {
		Vec3 cam = ctx.levelState().cameraRenderState.pos;
		if (cam == null || SiteGhosts.all().isEmpty()) {
			return;
		}
		for (SiteGhosts.Ghost g : SiteGhosts.all().values()) {
			if (g.remaining() == 0) {
				continue;
			}
			Set<Integer> next = g.nextDelivered();
			int[] faces = g.faces;
			ctx.submitNodeCollector().submitCustomGeometry(new PoseStack(), RenderTypes.debugFilledBox(), (pose, vc) -> {
				int quads = 0;
				for (int i = g.built.nextClearBit(0); i < g.queue.length; i = g.built.nextClearBit(i + 1)) {
					int f = faces[i];
					if (f == 0) {
						continue;
					}
					int argb = next.contains(i) ? NEXT : (ALPHA << 24) | (TemplateCells.color(g.states[i]) & 0xFFFFFF);
					if ((argb >>> 24) == 0) {
						continue;
					}
					float x = (float) (g.x(i) - cam.x);
					float y = (float) (g.y(i) - cam.y);
					float z = (float) (g.z(i) - cam.z);
					quads += cube(pose, vc, x - INFLATE, y - INFLATE, z - INFLATE, x + 1 + INFLATE, y + 1 + INFLATE, z + 1 + INFLATE, argb, f);
				}
				lastQuads = quads;
			});
		}
	}

	private static int cube(PoseStack.Pose p, VertexConsumer vc, float x0, float y0, float z0, float x1, float y1, float z1, int argb, int mask) {
		int n = 0;
		if ((mask & 1) != 0) {
			quad(p, vc, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, TemplateCells.shade(argb, FACE_SHADE[0]));
			n++;
		}
		if ((mask & 2) != 0) {
			quad(p, vc, x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0, TemplateCells.shade(argb, FACE_SHADE[1]));
			n++;
		}
		if ((mask & 4) != 0) {
			quad(p, vc, x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0, TemplateCells.shade(argb, FACE_SHADE[2]));
			n++;
		}
		if ((mask & 8) != 0) {
			quad(p, vc, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, TemplateCells.shade(argb, FACE_SHADE[3]));
			n++;
		}
		if ((mask & 16) != 0) {
			quad(p, vc, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, TemplateCells.shade(argb, FACE_SHADE[4]));
			n++;
		}
		if ((mask & 32) != 0) {
			quad(p, vc, x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, TemplateCells.shade(argb, FACE_SHADE[5]));
			n++;
		}
		return n;
	}

	private static void quad(PoseStack.Pose p, VertexConsumer vc, float ax, float ay, float az, float bx, float by, float bz, float cx, float cy,
		float cz, float dx, float dy, float dz, int argb) {
		vc.addVertex(p, ax, ay, az).setColor(argb);
		vc.addVertex(p, bx, by, bz).setColor(argb);
		vc.addVertex(p, cx, cy, cz).setColor(argb);
		vc.addVertex(p, dx, dy, dz).setColor(argb);
	}
}
