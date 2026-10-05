package dev.larattalabs.architect.client.api;

import dev.larattalabs.architect.api.ArchitectClientApi;
import dev.larattalabs.architect.api.PreviewStyle;
import dev.larattalabs.architect.client.placement.BuildPlacement;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;

/** {@link ArchitectClientApi} over {@link BuildPlacement}'s preview mode. Internal. */
public final class ClientApiImpl implements ArchitectClientApi {
	public static final ClientApiImpl INSTANCE = new ClientApiImpl();

	private ClientApiImpl() {
	}

	@Override
	public void preview(String blueprintId, BlockPos origin, Rotation rotation, PreviewStyle style) {
		BuildPlacement.startPreview(blueprintId, origin.getX(), origin.getY(), origin.getZ(), rotation == null ? 0 : rotation.ordinal());
	}

	@Override
	public void clearPreview() {
		if (BuildPlacement.preview()) {
			BuildPlacement.cancel();
		}
	}

	@Override
	public boolean previewing() {
		return BuildPlacement.preview();
	}
}
