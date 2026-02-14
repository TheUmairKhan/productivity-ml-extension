use serde::Serialize;
use std::io::{self, Read, Write};

pub fn read_message<R: Read>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 {
        return Ok(Some(Vec::new()));
    }

    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

pub fn write_message<W: Write, T: Serialize>(w: &mut W, payload: &T) -> io::Result<()> {
    let json = serde_json::to_vec(payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    let len = (json.len() as u32).to_le_bytes();

    w.write_all(&len)?;
    w.write_all(&json)?;
    w.flush()?;

    Ok(())
}
