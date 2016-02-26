{ Capper ? { outPath = ./.; name = "Capper"; }
, pkgs ? import <nixpkgs> {}
}:
let
  nodePackages = import "${pkgs.path}/pkgs/top-level/node-packages.nix" {
    inherit pkgs;
    inherit (pkgs) stdenv nodejs fetchurl fetchgit;
    neededNatives = [ pkgs.python ] ++ pkgs.lib.optional pkgs.stdenv.isLinux pkgs.utillinux;
    self = nodePackages;
    generated = ./package.nix;
  };
in rec {
  tarball = pkgs.runCommand "Capper-0.0.1.tgz" { buildInputs = [ pkgs.nodejs ]; } ''
    mv `HOME=$PWD npm pack ${Capper}` $out
  '';
  build = nodePackages.buildNodePackage {
    name = "Capper-0.0.1";
    src = [ tarball ];
    buildInputs = nodePackages.nativeDeps."Capper" or [];
    deps = [ nodePackages.by-spec."q"."~1.0.1" nodePackages.by-spec."express"."~3.4.1" ];
    peerDependencies = [];
  };
}