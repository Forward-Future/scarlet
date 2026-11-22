//! Minimal deflated zip writer (UTF-8 entry names, no zip64) for support log bundles.

use std::io::Write;

use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};

/// Minimal zip writer: deflated entries, UTF-8 names, no zip64 (a support bundle stays far below 4 GB).
pub(super) struct Zip {
    out: Vec<u8>,
    central: Vec<u8>,
    entries: u16,
    dos_time: u16,
    dos_date: u16,
}

impl Zip {
    pub(super) fn new() -> Self {
        let (y, mo, d, h, mi, s) = crate::util::civil_from_unix(crate::util::unix_now().as_secs() as i64);
        Zip {
            out: Vec::new(),
            central: Vec::new(),
            entries: 0,
            dos_time: ((h as u16) << 11) | ((mi as u16) << 5) | ((s as u16) / 2),
            dos_date: (((y.clamp(1980, 2107) - 1980) as u16) << 9) | ((mo as u16) << 5) | d as u16,
        }
    }

    pub(super) fn add(&mut self, name: &str, data: &[u8]) -> std::io::Result<()> {
        let mut crc = Crc::new();
        crc.update(data);
        let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
        enc.write_all(data)?;
        let packed = enc.finish()?;
        let too_big = || std::io::Error::other("log bundle too large");
        let (size, packed_size) = (u32::try_from(data.len()).map_err(|_| too_big())?, u32::try_from(packed.len()).map_err(|_| too_big())?);
        let offset = u32::try_from(self.out.len()).map_err(|_| too_big())?;
        let name_len = name.len() as u16;
        // Fields shared by the local header and the central directory entry, from "version needed" to "extra length".
        let mut common = Vec::with_capacity(26);
        common.extend_from_slice(&20u16.to_le_bytes()); // version needed: 2.0 (deflate)
        common.extend_from_slice(&0x0800u16.to_le_bytes()); // flags: UTF-8 names
        common.extend_from_slice(&8u16.to_le_bytes()); // method: deflate
        common.extend_from_slice(&self.dos_time.to_le_bytes());
        common.extend_from_slice(&self.dos_date.to_le_bytes());
        common.extend_from_slice(&crc.sum().to_le_bytes());
        common.extend_from_slice(&packed_size.to_le_bytes());
        common.extend_from_slice(&size.to_le_bytes());
        common.extend_from_slice(&name_len.to_le_bytes());
        common.extend_from_slice(&0u16.to_le_bytes()); // extra length

        self.out.extend_from_slice(&0x04034b50u32.to_le_bytes());
        self.out.extend_from_slice(&common);
        self.out.extend_from_slice(name.as_bytes());
        self.out.extend_from_slice(&packed);

        self.central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        self.central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        self.central.extend_from_slice(&common);
        self.central.extend_from_slice(&[0; 6]); // comment length, disk, internal attributes
        self.central.extend_from_slice(&[0; 4]); // external attributes
        self.central.extend_from_slice(&offset.to_le_bytes());
        self.central.extend_from_slice(name.as_bytes());
        self.entries += 1;
        Ok(())
    }

    pub(super) fn finish(mut self) -> Vec<u8> {
        let (cd_offset, cd_size) = (self.out.len() as u32, self.central.len() as u32);
        self.out.append(&mut self.central);
        self.out.extend_from_slice(&0x06054b50u32.to_le_bytes());
        self.out.extend_from_slice(&[0; 4]); // disk numbers
        self.out.extend_from_slice(&self.entries.to_le_bytes());
        self.out.extend_from_slice(&self.entries.to_le_bytes());
        self.out.extend_from_slice(&cd_size.to_le_bytes());
        self.out.extend_from_slice(&cd_offset.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes()); // comment length
        self.out
    }
}
