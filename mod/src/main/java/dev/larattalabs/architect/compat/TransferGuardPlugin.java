package dev.larattalabs.architect.compat;

import java.util.List;
import java.util.Set;
import org.objectweb.asm.tree.ClassNode;
import org.spongepowered.asm.mixin.extensibility.IMixinConfigPlugin;
import org.spongepowered.asm.mixin.extensibility.IMixinInfo;

/**
 * (FK-b, 5d) The optional mixin config's plugin: records that the Transfer API guard applied ({@code postApply} runs only after its
 * injector succeeded), for {@code FillGuard.checkTransferGuard}'s WARN at start and the gate. Loads no game class.
 */
public final class TransferGuardPlugin implements IMixinConfigPlugin {
	/** Whether the guard's mixin applied to Fabric's ContainerSlotWrapper. */
	public static volatile boolean applied;

	@Override
	public void onLoad(String mixinPackage) {
	}

	@Override
	public String getRefMapperConfig() {
		return null;
	}

	@Override
	public boolean shouldApplyMixin(String targetClassName, String mixinClassName) {
		return true;
	}

	@Override
	public void acceptTargets(Set<String> myTargets, Set<String> otherTargets) {
	}

	@Override
	public List<String> getMixins() {
		return null;
	}

	@Override
	public void preApply(String targetClassName, ClassNode targetClass, String mixinClassName, IMixinInfo mixinInfo) {
	}

	@Override
	public void postApply(String targetClassName, ClassNode targetClass, String mixinClassName, IMixinInfo mixinInfo) {
		if (mixinClassName.endsWith(".ContainerSlotWrapperMixin")) {
			applied = true;
		}
	}
}
