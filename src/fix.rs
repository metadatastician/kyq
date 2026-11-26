// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! `kyq fix FILE`: rewrite one file in canonical form, or leave it untouched.
//!
//! The new bytes go to a temporary file in the same directory, which is
//! flushed to disk and then renamed over the original. A reader therefore sees
//! either the old file or the new one, never a partial write. Before the
//! rename the original is read again; if it changed meanwhile, `fix` stops.
//! An invalid input, a refused comment or any I/O failure leaves the original
//! bytes as they were. Symbolic links and non-regular files are refused.
//! The replacement keeps the file's permission bits. It does not keep its
//! owner, extended attributes or hard links (the path gets a new inode).
use kyq::{Format, MAX_INPUT_BYTES};
use std::{
    error::Error,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

/// Removes the temporary file unless the rename consumed it.
struct TempFile(Option<PathBuf>);

impl Drop for TempFile {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, Box<dyn Error>> {
    let mut input = Vec::new();
    File::open(path)?
        .take(MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut input)?;
    Ok(input)
}

pub(crate) fn run(path: &Path, format: Format) -> Result<i32, Box<dyn Error>> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(
            "UNSUPPORTED_OPERATION: fix refuses a symbolic link; run it on the target file".into(),
        );
    }
    if !meta.is_file() {
        return Err("UNSUPPORTED_OPERATION: fix needs a regular file".into());
    }
    let input = read_bounded(path)?;
    let output = kyq::fix_bytes(&input, format)?;
    if output == input {
        println!("OK {}", path.display());
        return Ok(0);
    }
    let name = path
        .file_name()
        .ok_or("fix needs a file name")?
        .to_string_lossy()
        .into_owned();
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let temp_path = dir.join(format!(".{name}.kyq-fix-{}", std::process::id()));
    let mut temp = TempFile(None);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)?;
    temp.0 = Some(temp_path.clone());
    file.write_all(&output)?;
    file.set_permissions(meta.permissions())?;
    file.sync_all()?;
    drop(file);
    if read_bounded(path)? != input {
        return Err(
            "CONCURRENT_MODIFICATION: the file changed while fix ran; it was left as it is".into(),
        );
    }
    fs::rename(&temp_path, path)?;
    temp.0 = None;
    // Make the rename durable where the platform allows syncing a directory.
    #[cfg(unix)]
    if let Ok(handle) = File::open(&dir) {
        let _ = handle.sync_all();
    }
    println!("FIXED {}", path.display());
    Ok(0)
}
