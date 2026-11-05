module.exports = {
    project: '__PROJECT__',
    services: {
        postgres: {
            user: 'medusa',
            password: 'medusa',
            database: 'medusa-backend',
            port: __PG__,
        },
        redis: {
            port: __REDIS__,
        },
    },
    admin: {
        email: 'admin@__PROJECT__.local',
    },
    apps: {
        '__BACKEND__': {
            role: 'backend',
            port: __BACKEND_PORT__,
        },
        '__STORE__': {
            port: __STORE_PORT__,
        },
    },
    proxy: {
        domain: 'localhost',
        port: __HTTP__,
    },
    tunnel: {
        name: '__PROJECT__',
    },
}
