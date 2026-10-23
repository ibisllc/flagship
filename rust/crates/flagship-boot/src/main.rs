//! `flagship-boot`: with no subcommand it is the v1 `flagship-unseal` helper;
//! `flagship-boot unlock ...` runs the whole early-boot unlock.

use std::os::unix::ffi::OsStringExt;
use std::process::ExitCode;
use zeroize::Zeroize;

fn main() -> ExitCode {
    flagship_boot::hardening::harden();
    let mut args: Vec<Vec<u8>> = std::env::args_os()
        .skip(1)
        .map(OsStringExt::into_vec)
        .collect();
    let code = match args.split_first() {
        Some((first, rest)) if first.as_slice() == b"unlock" => {
            flagship_boot::unlock::main(rest, &mut std::io::stderr().lock())
        }
        _ => flagship_boot::compat::run(
            &args,
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        ),
    };
    args.zeroize();
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
