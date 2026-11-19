// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
// Independent model of verification/bounds; see verification/README.adoc.
use vstd::prelude::*;
verus! {
pub fn consume(used: usize, additional: usize, limit: usize) -> (result: Option<usize>)
    ensures
        match result {
            Some(total) => total as int == used as int + additional as int && total <= limit,
            None => used as int + additional as int > limit as int,
        },
{
    if used <= limit && additional <= limit - used {
        Some(used + additional)
    } else {
        None
    }
}
}
