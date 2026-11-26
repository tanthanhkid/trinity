//! Binary `trinity`. K01 chỉ có `--version` và `--help`; các lệnh `serve`, `migrate`, `seed`, `channel-lock`,
//! `healthcheck` thêm ở các issue sau (docs/rust/PLAN.md mục 4.1).

use clap::Parser;

/// Trinity: CRM, nhân sự, bán hàng trong một binary.
#[derive(Debug, Parser)]
#[command(name = "trinity", version, about)]
struct Cli {}

fn main() {
    let _cli = Cli::parse();
}
