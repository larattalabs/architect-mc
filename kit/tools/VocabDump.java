// (6c VOC) Dumps the per-block facts slice VOC adds that BlockDump does not carry: whether the default state random-ticks
// (`rt`: it may change on its own), the next weathering stage and the waxed form (`wx`: WeatheringCopper's NEXT_BY_BLOCK and
// HoneycombItem's WAXABLES), and the feature flags the block requires (`ff`, the vanilla flag left out). Run by
// kit/tools/gen-vocab.mjs with the Java 25 source launcher against the unobfuscated 26.3 server jar + its bundled libraries:
//   java -cp "<server-26.3.jar>:<libraries/**.jar>" VocabDump.java <out.json>
// A separate file from BlockDump.java so the fields BlockDump feeds (and slice H's and W's gates that read it) stay as they are.
import java.io.FileWriter;
import java.io.Writer;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

import net.minecraft.SharedConstants;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.flag.FeatureFlags;
import net.minecraft.world.item.HoneycombItem;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.WeatheringCopper;

public class VocabDump {
  static String q(String s) { return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }

  static String id(Block b) { return BuiltInRegistries.BLOCK.getKey(b).toString(); }

  public static void main(String[] args) throws Exception {
    SharedConstants.tryDetectVersion();
    Bootstrap.bootStrap();
    var next = WeatheringCopper.NEXT_BY_BLOCK.get();
    var waxed = HoneycombItem.WAXABLES.get();
    try (Writer w = new FileWriter(args[0])) {
      w.write("{\n");
      boolean first = true;
      for (Block b : BuiltInRegistries.BLOCK) {
        boolean rt = b.defaultBlockState().isRandomlyTicking();
        TreeSet<String> ff = new TreeSet<>();
        for (var f : FeatureFlags.REGISTRY.toNames(b.requiredFeatures())) ff.add(f.toString());
        ff.remove("minecraft:vanilla");
        List<String> ffq = new ArrayList<>();
        for (String f : ff) ffq.add(q(f));
        Block n = next.get(b);
        Block x = waxed.get(b);
        if (!first) w.write(",\n");
        first = false;
        w.write(q(id(b)) + ":{\"rt\":" + rt + ",\"ff\":[" + String.join(",", ffq) + "]" + (n != null ? ",\"next\":" + q(id(n)) : "")
          + (x != null ? ",\"waxed\":" + q(id(x)) : "") + "}");
      }
      w.write("\n}\n");
    }
    System.exit(0);
  }
}
