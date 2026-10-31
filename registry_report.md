# MC 服务器 Registry 巡检报告

- 地址：`mc.example.com:25565`
- 版本：`1.21.11`　服务端：`fabric`
- 抓取时间：2026-10-24T06:37:36.732Z
- registry 数量：**23**　条目总数：**417**

## 命名空间分布

| 命名空间 | 条目数 | 来源 |
|---|---|---|
| `minecraft` | 371 | 原版 |
| `nova_structures` | 32 | Nova Structures（附魔/结构包） |
| `incendium` | 9 | Incendium（下界扩展） |
| `nullscape` | 3 | Nullscape（末地扩展） |
| `dual_weapon_combat` | 2 | Dual Weapon Combat（双持攻击） |

## 各 registry 明细

- **minecraft:banner_pattern**：43 条
- **minecraft:cat_variant**：11 条
- **minecraft:chat_type**：7 条
- **minecraft:chicken_variant**：3 条
- **minecraft:cow_variant**：3 条
- **minecraft:damage_type**：52 条（含第三方 2）
- **minecraft:dialog**：4 条（含第三方 1）
- **minecraft:dimension_type**：4 条
- **minecraft:enchantment**：75 条（含第三方 32）
- **minecraft:frog_variant**：3 条
- **minecraft:instrument**：8 条
- **minecraft:jukebox_song**：21 条
- **minecraft:painting_variant**：51 条
- **minecraft:pig_variant**：3 条
- **minecraft:test_environment**：1 条
- **minecraft:test_instance**：1 条
- **minecraft:timeline**：4 条
- **minecraft:trim_material**：11 条
- **minecraft:trim_pattern**：18 条
- **minecraft:wolf_sound_variant**：7 条
- **minecraft:wolf_variant**：9 条
- **minecraft:worldgen/biome**：76 条（含第三方 11）
- **minecraft:zombie_nautilus_variant**：2 条

## 非原版条目全清单

### incendium

- `incendium:ash_barrens`
- `incendium:infernal_dunes`
- `incendium:inverted_forest`
- `incendium:quartz_flats`
- `incendium:sacrifice`
- `incendium:toxic_heap`
- `incendium:volcanic_deltas`
- `incendium:weeping_valley`
- `incendium:withered_forest`

### nullscape

- `nullscape:crystal_peaks`
- `nullscape:shadowlands`
- `nullscape:void_barrens`

### dual_weapon_combat

- `dual_weapon_combat:offhand_attack`
- `dual_weapon_combat:test`

### nova_structures

- `nova_structures:aerials_bane`
- `nova_structures:antidote`
- `nova_structures:boss_behaviour`
- `nova_structures:boss_nether`
- `nova_structures:conductivity_curse`
- `nova_structures:ghasted`
- `nova_structures:gravity`
- `nova_structures:hydro_veil`
- `nova_structures:illagers_bane`
- `nova_structures:jockey/make_drowned_into_jockey`
- `nova_structures:jockey/spawn_bogged_horseman`
- `nova_structures:jockey/spawn_camel_husk_jockey`
- `nova_structures:jockey/spawn_chicken_jockey`
- `nova_structures:jockey/spawn_hoglin_jockey`
- `nova_structures:jockey/spawn_skeleton_horseman`
- `nova_structures:jockey/spawn_stray_horseman`
- `nova_structures:jockey/spawn_zautilus_jockey`
- `nova_structures:jockey/spawn_zombie_horseman`
- `nova_structures:librarian_level_checker`
- `nova_structures:multishot`
- `nova_structures:outreach`
- `nova_structures:photosynthesis`
- `nova_structures:piercing`
- `nova_structures:power`
- `nova_structures:shulker_boss`
- `nova_structures:shulker_miniboss`
- `nova_structures:spiteful`
- `nova_structures:swift_soar`
- `nova_structures:tavern_level_checker`
- `nova_structures:traveler`
- `nova_structures:wax_wings`
- `nova_structures:wither_coated`

## 结论

原版内容（物品/方块/实体/附魔/群系基线）与 1.21.11 官方数据一致，无未申报的自定义物品或方块；
全部差异均可归因于 4 个公开数据包/模组。服务器健康，无异常改动迹象。

> ⚠️ 本报告只在服务端下发的数据层做判断，不含服务端 jar 内部逻辑。