// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! Resource accounting used by the native parser, with Pearlite contracts.
use creusot_std::prelude::*;

/// Consume a bounded amount without integer overflow.
#[ensures(match result {
    Some(total) => total@ == used@ + additional@ && total <= limit,
    None => used@ + additional@ > limit@
})]
pub fn consume(used: usize, additional: usize, limit: usize) -> Option<usize> {
    if used <= limit && additional <= limit - used {
        Some(used + additional)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::consume;
    #[test]
    fn boundaries_and_overflow() {
        assert_eq!(consume(4, 6, 10), Some(10));
        assert_eq!(consume(4, 7, 10), None);
        assert_eq!(consume(usize::MAX, 1, usize::MAX), None);
        assert_eq!(consume(usize::MAX, 0, usize::MAX), Some(usize::MAX));
        assert_eq!(consume(1, 0, 0), None);
    }
}
