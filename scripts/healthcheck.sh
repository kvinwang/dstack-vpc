if [ -x /var/run/dstack-healthcheck.sh ]; then
    /var/run/dstack-healthcheck.sh
else
    exit 1
fi