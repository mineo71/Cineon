// Species art and palettes, copied verbatim from Cineon/Profile/PixelPet.swift by way of
// windows/Cineon.Core/Profile/PetArt.Species.cs (converted mechanically; do not edit by hand).
import type { PetSpecies, PetTone } from "./petTypes";
import { patch, sym, type SpriteSet } from "./petArtBuild";

/**
 * Palette per species and tone: o outline, b base, s shade, l light, a accent, c detail, d dark detail
 * (optional e eye ink, i mouth ink; both default to the outline).
 */
export const PALETTE_SPECS: Readonly<Record<PetSpecies, Readonly<Record<PetTone, string>>>> = {
  fox: {
    classic: "o=2a1a1f b=f2873a s=c95a26 l=ffb066 a=fff3e2 c=5b2f25 d=ff9aa2",
    sunny: "o=2e1c14 b=f7b538 s=d4861f l=ffd77a a=fff7e6 c=7a4a1e d=ff9f8f",
    dusk: "o=1e2130 b=8c96a8 s=646d80 l=b6bfcd a=f4f6fa c=3b4150 d=f1a0b5",
  },
  turtle: {
    classic: "o=1f2a1a b=9ad86a s=6aac48 l=c6f09c a=b07a3e c=7a4e26 d=d9a45c",
    sunny: "o=2a2414 b=b4e66e s=84b844 l=dcf8a8 a=e0a030 c=a86a1a d=f7cd6a",
    dusk: "o=161c2a b=7fc4b0 s=559a88 l=b0eadc a=5e6a8a c=3c4560 d=8e9abc",
  },
  cat: {
    classic: "o=241c2b b=9aa0b8 s=6e7390 l=c4c9db a=eef0f6 c=ff9ab0 d=5d6280",
    sunny: "o=2e1c16 b=f0a860 s=d08040 l=ffd09a a=fff4e4 c=ff8f8f d=c06a2c",
    dusk: "o=15121c b=4a4560 s=343048 l=6a6588 a=8c86aa c=ff8fb0 d=2a2638 e=ffd23f",
  },
  frog: {
    classic: "o=1c2a1e b=7ccf5a s=4f9c3c l=b4ec8a a=eaf7b8 c=ff8fa3 d=3a7a2e",
    sunny: "o=2e2010 b=f5c542 s=d99a28 l=ffe48a a=fff6d6 c=ff8f8f d=c07a1c",
    dusk: "o=141c30 b=4f8fe0 s=3463a8 l=8ab8ff a=d8e8ff c=ff9fd0 d=1f3a70",
  },
  raccoon: {
    classic: "o=1d1a22 b=9c9caa s=6e6e7e l=c6c6d0 a=f0f0f4 c=403c4a d=5a5866 e=0c0a10",
    sunny: "o=2a1e16 b=c0a088 s=957a64 l=dcc4ae a=fbf3ea c=4e3a30 d=6e5646 e=120c08",
    dusk: "o=12121c b=6a6c86 s=4c4e66 l=8e90aa a=dcdcea c=26263a d=3a3c52 e=e8e4ff",
  },
  raven: {
    classic: "o=14121c b=3d3a5c s=2a2742 l=6f6a9a a=8a85b8 c=f2c14e d=23203a e=0a0810",
    sunny: "o=1a1420 b=4a3a6a s=33284c l=8070b0 a=a090d0 c=ffb040 d=2a2040 e=0a0810",
    dusk: "o=0c0c14 b=2c2c3a s=1c1c28 l=58586e a=70708a c=d0d4e0 d=141420 e=ff4a5a",
  },
  ghost: {
    classic: "o=2a2340 b=f4f2ff s=c9c3ea l=ffffff a=e2def8 c=ffa6c9 d=8a80c0",
    sunny: "o=1e3028 b=e6fbef s=b0e0c6 l=ffffff a=d0f2de c=ffa6b8 d=70b090",
    dusk: "o=1a1430 b=9a90d0 s=7268b0 l=c4bcf0 a=8a80c4 c=ff9fd8 d=4a4080",
  },
  robot: {
    classic: "o=1c2030 b=a9b8cc s=7486a0 l=d6e0ec a=5a6a88 c=ff5a5a d=1e2a44 e=5ef2ff i=5ef2ff t=2aa8c0",
    sunny: "o=2a2016 b=e8c070 s=b8904a l=fde3a8 a=a07838 c=ff6a4a d=2a2238 e=8affc1 i=8affc1 t=4ab880",
    dusk: "o=0e1018 b=5a6078 s=3e4358 l=7e86a2 a=2e3244 c=ff5ad0 d=10131f e=ff7ae0 i=ff7ae0 t=b04a9a",
  },
  dragon: {
    classic: "o=22183a b=a07ef0 s=7656c4 l=c8b0ff a=ffd98a c=fff1c8 d=6a4ab8",
    sunny: "o=2e1410 b=ff7a4a s=d8542c l=ffa878 a=ffe08a c=fff4d0 d=c03a2a",
    dusk: "o=0e2024 b=3f9a8e s=2c7268 l=6ccab8 a=d8f0c0 c=e8f4f0 d=1e5450",
  },
  owl: {
    classic: "o=2a1c16 b=9a6a44 s=70482c l=c89a6a a=fff1d6 c=f0a030 d=5a3a22",
    sunny: "o=3a3028 b=d8d0c2 s=aaa090 l=f4efe6 a=ffffff c=f5b030 d=7a7060",
    dusk: "o=161a26 b=6a7088 s=4c5068 l=9098b0 a=e0e4f0 c=f0c040 d=3a3e52",
  },
  slime: {
    classic: "o=12303a b=5fd3c0 s=37a698 l=a8f5e8 a=e8fffb c=ff9fb8 d=2f8c80",
    sunny: "o=3a1428 b=ff9fc8 s=e070a0 l=ffc8e0 a=fff0f6 c=ff6f9f d=c05080",
    dusk: "o=1a1238 b=8a6ae0 s=6248b8 l=b8a0ff a=ece6ff c=ff9fd8 d=4a3496",
  },
  bunny: {
    classic: "o=3a2430 b=fbf3f5 s=e0cad4 l=ffffff a=ffe6ee c=ff9fbf d=d0b0c0",
    sunny: "o=3a2418 b=e8b88a s=c8925e l=f8d8b0 a=fff0e0 c=ff9f9f d=a87040",
    dusk: "o=1e1a2a b=a8a0b8 s=80789a l=cac4d6 a=ece8f4 c=ff9fc8 d=5e5674",
  },
  puppy: {
    classic: "o=2e1f18 b=e8b878 s=c48e50 l=f8d8a8 a=fff4e2 c=8a5a34 d=6a4428",
    sunny: "o=2a2228 b=fbf7f0 s=ddd4c8 l=ffffff a=ffffff c=3a3236 d=2a2428",
    dusk: "o=161a24 b=9aa4b4 s=707a8c l=c4ccd8 a=f4f6fa c=5a6274 d=3e4452",
  },
  songbird: {
    classic: "o=3a2a14 b=ffd84a s=e8a828 l=fff0a0 a=fff8d8 c=ff8a3a d=d89020",
    sunny: "o=3a1820 b=ff9fb0 s=e07088 l=ffd0d8 a=fff0f2 c=ff8a3a d=c05068",
    dusk: "o=141c34 b=5a8ae0 s=3a62b0 l=9ab8ff a=e8f0ff c=ffb040 d=2a4a90",
  },
  hedgehog: {
    classic: "o=2a1c14 b=8a6040 s=5e3e28 l=b08458 a=f6dcb4 c=3a2418 d=ffa0a0",
    sunny: "o=2e2014 b=c89058 s=9a6a38 l=e0b07a a=fff0d8 c=3a2418 d=ffa0a0",
    dusk: "o=161620 b=6a6a7a s=4a4a58 l=8e8ea0 a=e8e6f0 c=1e1e28 d=ff9fc0",
  },
};

const fox: SpriteSet = {
    baby: sym(`
        .o.....
        .oo.ooo
        .obobbb
        obbbbbb
        obEEbbb
        obEEbbb
        obaaaao
        .oaaaaM
        ..ooaaa
        ..obbaa
        ..obbbb
        ...ooo.
        `, 1, 8, [9, 10],
        [patch(10, 6, `
            .ooo
            obbo
            obao
            ooo.
            `)]),
    teen: sym(`
        .o......
        .oo.....
        .obooooo
        .obbbbbb
        obbbbbbb
        obbEEbbb
        obaEEbbb
        obaaaaao
        .oaaaaaM
        ..ooaaaa
        ..obbaaa
        ..obbaaa
        ..obbbaa
        ...ooo.o
        `, 2, 9, [11, 12],
        [patch(12, 7, `
            ...oo.
            ..oaao
            .obbao
            obbbo.
            obbo..
            ooo...
            `)]),
    adult: sym(`
        .o.......
        .oo......
        .obo.....
        .obco....
        .obcboooo
        .obbbbbbb
        obbbbbbbb
        obbbEEbbb
        obaaEEbbb
        obaaaaaao
        .oaaaaaaM
        ..ooaaaaa
        ...obbaaa
        ..obbbaaa
        ..obbbaaa
        ..obbbbaa
        ..occobbb
        ...ooo.oo
        `, 4, 11, [12, 16],
        [patch(13, 9, `
            ....ooo.
            ...oaaao
            ..obaaao
            ..obbbao
            .obbbbo.
            obbbbbo.
            obbbbo..
            .oooo...
            `)])
};

const turtle: SpriteSet = {
    baby: sym(`
        ...oooo
        ..obbbb
        .obbbbb
        .obEEbb
        oobEEbb
        odobpbM
        odaoooo
        oacdddd
        occcccc
        ooooooo
        .obo...
        .oo....
        `, 0, 6, [9, 9]),
    teen: sym(`
        ....oooo
        ...obbbb
        ..obbbbb
        ..obEEbb
        ooobEEbb
        odobpbbM
        odaobbbb
        oacaoooo
        oacacddd
        occccddd
        oaaacccc
        oooooooo
        .obbo...
        .ooo....
        `, 0, 7, [11, 12]),
    adult: sym(`
        .....oooo
        ....obbbb
        ...obbbbb
        ...obbbbb
        ..oobEEbb
        .odobEEbb
        odaobpbbM
        odaaobbbb
        oaacaoooo
        oaacacddd
        occcccddd
        oaacacddd
        oaaaacccc
        ooooooooo
        .obbo....
        .ooo.....
        `, 0, 8, [13, 14])
};

const cat: SpriteSet = {
    baby: sym(`
        .o.....
        .ocoooo
        obcbdbd
        obbbbbb
        obEEbbb
        obEEbbb
        obbbbac
        .obbbaM
        ..oobaa
        ..obaaa
        ..oaaob
        ...oo.o
        `, 1, 8, [9, 10],
        [patch(10, 5, `
            ..oo
            .obo
            .obo
            obo.
            oo..
            `)]),
    teen: sym(`
        .o......
        .oo.....
        .ocooooo
        .occbdbd
        obbbbbbd
        obbEEbbb
        obbEEbbb
        obbbbaac
        .obbbaaM
        ..oobbaa
        ..obbaaa
        ..obaaaa
        ..oaaobb
        ...oo.oo
        `, 2, 9, [11, 12],
        [patch(12, 5, `
            ..oo.
            .obdo
            .obo.
            .obo.
            .obo.
            obo..
            bo...
            `)]),
    adult: sym(`
        .o.......
        .oo......
        .oco.....
        .occooooo
        .obcbbdbd
        obbbbbbbd
        obbbbbbbb
        obbbEEbbb
        obbbEEbbb
        obbbbbaac
        .obbbbaaM
        ..oobbbaa
        ...obbbbb
        ..obbbaaa
        ..obbaaaa
        ..obbaaaa
        ..oaaobbb
        ...oo.ooo
        `, 3, 11, [12, 16],
        [patch(14, 7, `
            ..oo.
            .obdo
            .obo.
            .obo.
            .obo.
            .obo.
            obo..
            bo...
            `)])
};

const frog: SpriteSet = {
    baby: sym(`
        .ooo...
        obbbo..
        obEEboo
        obEEbbb
        obbbbbb
        opbbbbM
        .obbbbb
        .obaaaa
        obbaaaa
        ooboooo
        oo.....
        `, 2, 6, [9, 9]),
    teen: sym(`
        .ooo....
        obbbo...
        obEEbooo
        obEEbbbb
        obbbbbbb
        opbbbbbM
        .obbbbbb
        .obaaaaa
        obbaaaaa
        obobaaaa
        obobbbbb
        oooooooo
        `, 2, 6, [11, 10]),
    adult: sym(`
        ..ooo....
        .obbbo...
        obbEEbooo
        obbEEbbbb
        obbbbbbbb
        obpbbbbbb
        obbbbbbbM
        .obbbbbbb
        .obbaaaaa
        obbaaaaaa
        obobaaaaa
        obobbaaaa
        obbobbbbb
        ooooooooo
        `, 2, 7, [13, 12])
};

const raccoon: SpriteSet = {
    baby: sym(`
        .oo....
        odboooo
        obbbbbb
        obaabba
        ocEEcba
        ocEEcba
        obccbao
        .obbaaM
        ..oobaa
        ..obbaa
        ..oddob
        ...oo.o
        `, 1, 8, [9, 10],
        [patch(10, 4, `
            ..oo
            .odo
            .obo
            odo.
            obo.
            oo..
            `)]),
    teen: sym(`
        .oo.....
        odbooooo
        obbbbbbb
        obaabbba
        ocEEccba
        ocEEccba
        obcccbaa
        .obbaaao
        ..obaaaM
        ...oobaa
        ..obbbaa
        ..obbaaa
        ..oddobb
        ...oo.oo
        `, 1, 9, [11, 12],
        [patch(12, 5, `
            ...oo
            ..odo
            ..obo
            .odo.
            .obo.
            odo..
            oo...
            `)]),
    adult: sym(`
        .oo......
        odbo.....
        odbbooooo
        obbbbbbbb
        obaaabbba
        occEEccba
        occEEccba
        obccccbaa
        .obbbaaao
        ..obbaaaM
        ...oobaaa
        ...obbbbb
        ..obbbaaa
        ..obbaaaa
        ..obbaaaa
        ..obbbaab
        ..oddobbb
        ...oo.ooo
        `, 2, 10, [12, 16],
        [patch(14, 6, `
            ....oo
            ...odo
            ...obo
            ..odo.
            ..obo.
            .odo..
            .obo..
            odo...
            obo...
            oo....
            `)])
};

const raven: SpriteSet = {
    baby: sym(`
        ...oooo
        .oobbbb
        .obbbbb
        obllllb
        oblEElb
        oblEElb
        obbbocc
        .obbboc
        ..obbbo
        ..obsbb
        ..ooooo
        ...c..c
        `, 0, 8, [9, 10]),
    teen: sym(`
        ......o.
        ....oobo
        ..oobbbb
        .obbbbbb
        .obllllb
        .oblEElb
        .oblEElb
        .obbbocc
        ..obbboc
        ..obbbbo
        osobblll
        osobblll
        .ooobbbb
        ...ooooo
        ....c...
        `, 2, 9, [11, 13]),
    adult: sym(`
        .......o.
        .....oobo
        ...oobbbb
        ..obbbbbb
        .obllllbb
        .oblEElbb
        .oblEElbb
        .obbllocc
        ..obbbboc
        ..obbbbbo
        .oobbbbbb
        ossobllll
        ossobllll
        ossobllll
        .osobllll
        ..oobbbbb
        ...oooooo
        ....c...c
        `, 2, 10, [13, 16])
};

const ghost: SpriteSet = {
    baby: sym(`
        ...oooo
        .oobbbb
        .obbbbb
        obbbbbb
        obEEbbb
        obEEbbb
        obcbbbM
        obbbbbb
        osbbbbb
        obboobb
        .oo..oo
        .......
        `, 0, 7, [9, 9]),
    teen: sym(`
        ...ooooo
        ..obbbbb
        .obbbbbb
        .oblbbbb
        obbEEbbb
        obbEEbbb
        obcbbbbM
        obbbbbbb
        osbbbbbb
        osbbbbbb
        obbooobb
        .oo...oo
        ........
        `, 0, 8, [11, 10]),
    adult: sym(`
        ....ooooo
        ..oobbbbb
        .obbbbbbb
        .oblbbbbb
        obbbbbbbb
        obbbEEbbb
        obbbEEbbb
        obbcbbbbM
        obbbbbbbb
        obbbbbbbb
        osbbbbbbb
        osbbbbbbb
        osbbbbbbb
        obbboobbb
        .ooo..ooo
        .........
        `, 0, 9, [13, 12])
};

const robot: SpriteSet = {
    baby: sym(`
        ......o
        .....oc
        ......o
        .oooooo
        obbbbbb
        obddddd
        obdEEdd
        obdEEdd
        obddddM
        obbbbbb
        ooooooo
        ..obaaa
        ..ooooo
        ..oo.oo
        `, 3, 10, [9, 12]),
    teen: sym(`
        .......o
        ......oc
        .......o
        .ooooooo
        olllllll
        obdddddd
        obdEEddd
        obdEEddd
        obdddddM
        obbbbbbb
        oooooooo
        ..obbbbb
        .oobaaca
        ..obbbbb
        ..ooo.oo
        `, 3, 10, [11, 13]),
    adult: sym(`
        .......oo
        .......oc
        .......oo
        ........o
        .oooooooo
        .olllllll
        .obdddddd
        .obdEEddd
        .obdEEddd
        .obdddddM
        .obdddddd
        .obbbbbbb
        .oooooooo
        ...obbbbb
        .oobaaaaa
        ooobaacaa
        ..obaaaaa
        ..obbbbbb
        ...oob.ob
        ...ooo.oo
        `, 4, 12, [13, 18])
};

const dragon: SpriteSet = {
    baby: sym(`
        ..o....
        .oco...
        .occooo
        .obbbbb
        obbbbbb
        obEEbbb
        obEEbbb
        oblloll
        .ollllM
        ..oolll
        ..obaaa
        ..obaaa
        ...oo.o
        `, 2, 9, [9, 11],
        [patch(10, 8, `
            ..o.
            .obo
            obo.
            oo..
            `)]),
    teen: sym(`
        ..o.....
        .oco....
        .occo...
        ..occooo
        .obbbbbb
        obbEEbbb
        obbEEbbb
        obblllol
        .obllllM
        ..oollll
        o.oobaaa
        odoobaaa
        oddobaaa
        .oobbbbb
        ..ooo.oo
        `, 3, 9, [11, 13],
        [patch(12, 9, `
            ....o
            ...oc
            ..obo
            .obo.
            obo..
            oo...
            `)]),
    adult: sym(`
        ..o......
        .oco.....
        .occo....
        ..occoooo
        ..obbbbbb
        .obbbbbbb
        .obbEEbbb
        .obbEEbbb
        .obbbbbbb
        .obllloll
        .oblllllM
        ..oolllll
        o..oobaaa
        odoobbaaa
        oddobbaaa
        .oobbbaaa
        ...obbaaa
        ...obbbbb
        ...occobb
        ....ooo.o
        `, 3, 11, [12, 18],
        [patch(13, 12, `
            .....o.
            ....oco
            ...obo.
            ..obbo.
            .obbo..
            obbo...
            ooo....
            `)])
};

const owl: SpriteSet = {
    baby: sym(`
        .o.....
        .oo....
        .oboooo
        obbaabb
        obaEEab
        obaEEao
        obbaaoc
        obllllo
        osldlll
        osllldl
        .oooooo
        ..c..c.
        `, 2, 7, [9, 10]),
    teen: sym(`
        .o......
        .oo.....
        .obooooo
        obbbbbbb
        obbaabbb
        obaEEabb
        obaEEaoc
        obbaaboc
        obbbbbbo
        osllllll
        osldlldl
        osllllll
        .ooooooo
        ...c...c
        `, 2, 8, [11, 12]),
    adult: sym(`
        ..o......
        ..oo.....
        ..obooooo
        .obbbbbbb
        obbbaabbb
        obbaEEabb
        obbaEEaoc
        obbbaaboc
        obbbbbbbo
        .obllllll
        osllldlld
        oslllllll
        osldllldl
        oslllllll
        .osllllll
        ..ooooooo
        ....c...c
        `, 2, 8, [13, 15])
};

const slime: SpriteSet = {
    baby: sym(`
        ......o
        .....ob
        ...oobb
        ..obbbb
        .oblabb
        .obEEbb
        obbEEbb
        obcbbbM
        osbbbbb
        .osssss
        ..ooooo
        `, 2, 8, [9, 9]),
    teen: sym(`
        .......o
        ......ob
        ....oobb
        ...obbbb
        ..oblabb
        .oblabbb
        .obEEbbb
        obbEEbbb
        obcbbbbM
        obbbbbbb
        osbbbbbb
        .osssbbb
        ..oooooo
        `, 2, 10, [11, 11]),
    adult: sym(`
        ........o
        .......ob
        ......obb
        ....oobbb
        ...obbbbb
        ..oblabbb
        .oblabbbb
        .obbbbbbb
        .obbEEbbb
        obbbEEbbb
        obcbbbbbM
        obbbbbbbb
        obbbbbbbb
        osbbbbbbb
        .ossbbbbb
        ..ooooooo
        `, 3, 12, [13, 14])
};

const bunny: SpriteSet = {
    baby: sym(`
        ..oo...
        .obo...
        .oco...
        .ocoooo
        obbbbbb
        obEEbbb
        obEEbbb
        ocbbbbc
        .obbbbM
        ..obaaa
        ..obaaa
        ...oo.o
        `, 3, 8, [9, 10]),
    teen: sym(`
        ...oo...
        ..obbo..
        ..ocbo..
        ..ocbo..
        .oocbooo
        .obbbbbb
        obbbbbbb
        obbEEbbb
        obbEEbbb
        obcbbbbc
        .obbbbbM
        ..oobbbb
        ..obaaaa
        ..obaaaa
        ...oo.oo
        `, 4, 11, [11, 13]),
    adult: sym(`
        ....oo...
        ...obbo..
        ...ocbo..
        ...ocbo..
        ...ocbo..
        ..oocbooo
        .obbbbbbb
        obbbbbbbb
        obbbEEbbb
        obbbEEbbb
        obcbbbbbc
        .obbbbbbM
        ..oobbbbb
        ..obbaaaa
        .obbaaaaa
        .obbaaaaa
        .oobbbbbb
        ..ooo.ooo
        `, 5, 12, [13, 16])
};

const puppy: SpriteSet = {
    baby: sym(`
        ...oooo
        ..obbbb
        .ocobbb
        occoEEb
        occoEEb
        occobaa
        .ooobao
        ..obaaM
        ..ooaaa
        ..obbaa
        ..oaaob
        ...oo.o
        `, 0, 8, [9, 10]),
    teen: sym(`
        ...ooooo
        ..obbbbb
        .occobbb
        occcobbb
        occoEEbb
        occoEEbb
        occobbaa
        .ooobaao
        ...obaaM
        ...ooaaa
        ..obbaaa
        ..obbaaa
        ..oaaobb
        ...oo.oo
        `, 0, 9, [11, 12],
        [patch(12, 8, `
            ..oo
            .obo
            obo.
            oo..
            `)]),
    adult: sym(`
        ....ooooo
        ..oobbbbb
        .occobbbb
        occcobbbb
        occcobbbb
        occcobEEb
        occcobEEb
        occcobbaa
        .occobaaa
        ..ooobaao
        ....obaaM
        ....ooaaa
        ...obbbbb
        ..obbbaaa
        ..obbaaaa
        ..obbaaaa
        ..oaaobbb
        ...oo.ooo
        `, 0, 11, [12, 16],
        [patch(14, 11, `
            ..oo
            .obo
            .obo
            obo.
            oo..
            `)])
};

const songbird: SpriteSet = {
    baby: sym(`
        ......o
        .....ob
        ...oobb
        ..obbbb
        .obbbbb
        .obEEbb
        obbEEbb
        obpbboc
        osbaaao
        osaaaaa
        .oooooo
        ...c...
        `, 2, 8, [9, 10]),
    teen: sym(`
        .......o
        ......ob
        ....oobb
        ...obbbb
        ..obbbbb
        .obEEbbb
        obbEEbbb
        obpbbboc
        osbbbbbo
        ossbaaaa
        ossbaaaa
        .osbaaaa
        ..oooooo
        .....c..
        `, 2, 8, [11, 12]),
    adult: sym(`
        ........o
        .......ob
        .....oobb
        ...oobbbb
        ..obbbbbb
        .obbbbbbb
        .obEEbbbb
        obbEEbocc
        obpbbbboc
        obbbbbbbo
        osbbbaaaa
        ossbaaaaa
        ossbaaaaa
        .osbbaaaa
        ..oobbbbb
        ....ooooo
        .....c...
        `, 2, 10, [13, 14])
};

const hedgehog: SpriteSet = {
    baby: sym(`
        ..o...o
        .obo.ob
        obbbobb
        obbaaaa
        obaEEaa
        obaEEaa
        obdaaac
        .obaaaM
        ..obbaa
        ..oaaob
        ...oo.o
        `, 2, 8, [9, 9]),
    teen: sym(`
        ...o...o
        ..obo.ob
        .obbbobb
        obbbaaaa
        .obaaaaa
        obaEEaaa
        .oaEEaaa
        obbdaaac
        .obbaaaM
        ..obbaaa
        ..obbaaa
        ..oaaobb
        ...oo.oo
        `, 2, 9, [11, 11]),
    adult: sym(`
        ....o...o
        ...obo.ob
        ..obbbobb
        .obbbbbbb
        obbbaaaaa
        .obaaaaaa
        obbaEEaaa
        .obaEEaaa
        obbdaaaaa
        .obbaaaac
        ..obbaaaM
        ...obbaaa
        ..obbbaaa
        ..obbaaaa
        ..obbaaaa
        ..oaaobbb
        ...oo.ooo
        `, 2, 11, [12, 15])
};

export const SPRITE_SETS: Readonly<Record<PetSpecies, SpriteSet>> = {
  fox,
  turtle,
  cat,
  frog,
  raccoon,
  raven,
  ghost,
  robot,
  dragon,
  owl,
  slime,
  bunny,
  puppy,
  songbird,
  hedgehog,
};
