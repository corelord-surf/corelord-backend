const sql = require('mssql');

const config = {
  user: 'sqladmin',
  password: '6dHAy!g#qa^tSuBR',
  server: 'corelord-sqlserver.database.windows.net',
  database: 'CoreLordDB',
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

async function insertUserProfile(profile) {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request()
      .input('Email', sql.NVarChar(256), profile.email)
      .input('FullName', sql.NVarChar(100), profile.fullName)
      .input('Country', sql.NVarChar(100), profile.country)
      .input('PhoneNumber', sql.NVarChar(50), profile.phoneNumber)
      .query(`
        INSERT INTO UserProfiles (Email, FullName, Country, PhoneNumber)
        VALUES (@Email, @FullName, @Country, @PhoneNumber)
      `);

    return result;
  } catch (err) {
    console.error('SQL error', err);
    throw err;
  }
}

module.exports = {
  insertUserProfile
};
